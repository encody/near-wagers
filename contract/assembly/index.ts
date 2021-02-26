//@nearfile out
import {
  context,
  env,
  logging,
  PersistentMap,
  PersistentUnorderedMap,
  storage,
  u128,
} from 'near-sdk-as';
import { AccountId, SymbolId, Wager, WagerId } from './model';

const ERR_ALREADY_MINTED = 'Already minted';
const ERR_INVALID_ACCOUNT = 'Invalid account';
const ERR_INVALID_AMOUNT = 'Invalid amount';
const ERR_INVALID_TIME = 'Invalid time';
const ERR_INVALID_WAGER = 'Invalid wager id';
const ERR_INVALID_SYMBOL = 'Invalid symbol';
const ERR_CANNOT_ACCEPT = 'Cannot accept wager';
const ERR_CANNOT_RESCIND = 'Cannot rescind wager';
const ERR_INSUFFICIENT_BALANCE = 'Insufficient balance';

const TOTAL_SUPPLY = u128.Max;

export function wagerId(): WagerId {
  const w = storage.getPrimitive<u64>('wagerId', 1);
  storage.set<u64>('wagerId', w + 1);
  return w;
}

const balances = new PersistentMap<AccountId, u128>('b');
const wagers = new PersistentMap<WagerId, Wager>('w');
const userWagers = new PersistentMap<AccountId, u64[]>('u');
const symbols = new PersistentUnorderedMap<SymbolId, u64[]>('s');

export function getSymbols(): string[] {
  return symbols.keys();
}

export function getWagersForSymbol(symbol: SymbolId): u64[] {
  assert(symbols.contains(symbol), ERR_INVALID_SYMBOL);
  return symbols.getSome(symbol);
}

export function getWagersForAccount(account: AccountId): u64[] {
  assert(balances.contains(account), ERR_INVALID_ACCOUNT);
  return userWagers.get(account, [])!;
}

export function getWager(wagerId: WagerId): Wager {
  assert(wagers.contains(wagerId), ERR_INVALID_WAGER);
  return wagers.getSome(wagerId);
}

export function clearAccountWagers(account: AccountId): void {
  userWagers.set(account, []);
}

export function clearSymbolWagers(symbol: SymbolId): void {
  symbols.set(symbol, []);
}

export function reportSymbol(symbol: SymbolId, value: u128): void {
  // TODO: Allow users to register as an oracle and specify an oracle in wagers so that wagers will only respond to symbols reported by a designated oracle.
  assert(
    storage.getString('oracle') == context.predecessor,
    ERR_INVALID_ACCOUNT,
  );
  const wagerIds = symbols.get(symbol);

  if (wagerIds != null) {
    for (let i = 0; i < wagerIds.length; i++) {
      const wager = wagers.getSome(wagerIds[i]);
      if (
        wager.at <= context.blockTimestamp &&
        wager.over != '' &&
        wager.under != ''
      ) {
        distributeWinnings(wager, value);
        deleteWager(wager);
      }
    }
  }
}

function distributeWinnings(wager: Wager, symbolValue: u128): void {
  // TODO: Should a fee be taken out of winnings and given to the oracle to help the oracle recoup costs of the (possibly somewhat expensive) responsibility for reporting the symbol's value?
  if (symbolValue > wager.value) {
    // Over wins
    const winnings = u128.add(wager.bet, wager.bet);
    const overBalance = balances.getSome(wager.over);
    balances.set(wager.over, u128.add(overBalance, winnings));
  } else if (symbolValue < wager.value) {
    // Under wins
    const winnings = u128.add(wager.bet, wager.bet);
    const underBalance = balances.getSome(wager.under);
    balances.set(wager.under, u128.add(underBalance, winnings));
  } else {
    // Tie
    const underBalance = balances.getSome(wager.under);
    const overBalance = balances.getSome(wager.over);
    balances.set(wager.under, u128.add(underBalance, wager.bet));
    balances.set(wager.over, u128.add(overBalance, wager.bet));
  }
}

export function rescindWager(wagerId: WagerId): void {
  assert(wagers.contains(wagerId), ERR_INVALID_WAGER);
  assert(userWagers.contains(context.predecessor), ERR_INVALID_ACCOUNT);

  const wager = wagers.getSome(wagerId);

  assert(
    (wager.over == context.predecessor && wager.under == '') ||
      (wager.under == context.predecessor && wager.over == ''),
    ERR_CANNOT_RESCIND,
  );

  deleteWager(wager);

  const balance = balances.getSome(context.predecessor);
  balances.set(context.predecessor, u128.add(balance, wager.bet));
}

function deleteWager(wager: Wager): void {
  const userWagersList = userWagers.getSome(context.predecessor);
  userWagersList.splice(userWagersList.indexOf(wager.id), 1);
  userWagers.set(context.predecessor, userWagersList);
  const symbolWagersList = symbols.getSome(wager.symbol);
  symbolWagersList.splice(symbolWagersList.indexOf(wager.id), 1);
  symbols.set(wager.symbol, symbolWagersList);
  wagers.delete(wager.id);
}

export function acceptWager(wagerId: WagerId): void {
  assert(wagers.contains(wagerId), ERR_INVALID_WAGER);
  assert(balances.contains(context.predecessor), ERR_INVALID_ACCOUNT);

  const wager = wagers.getSome(wagerId);
  assert(
    wager.at > context.blockTimestamp && // Wager has not expired
      (wager.under == '' || wager.over == '') && // Wager is open
      wager.over != context.predecessor && // Cannot accept own wager
      wager.under != context.predecessor,
    ERR_CANNOT_ACCEPT,
  );
  const balance = balances.getSome(context.predecessor);

  assert(balance >= wager.bet, ERR_INSUFFICIENT_BALANCE);

  if (wager.over == '') {
    wager.over = context.predecessor;
  } else {
    wager.under = context.predecessor;
  }

  balances.set(context.predecessor, u128.sub(balance, wager.bet));
  wagers.set(wager.id, wager);

  const userWagersList = userWagers.get(context.predecessor, [])!;

  userWagersList.push(wager.id);

  userWagers.set(context.predecessor, userWagersList);
}

export function createWager(
  symbol: SymbolId,
  isOver: boolean,
  value: u128,
  bet: u128,
  at: u64,
): void {
  assert(bet > u128.Zero, ERR_INVALID_AMOUNT);
  assert(value > u128.Zero, ERR_INVALID_AMOUNT);
  assert(at > context.blockTimestamp, ERR_INVALID_TIME);
  assert(balances.contains(context.predecessor), ERR_INVALID_ACCOUNT);
  const balance = balances.getSome(context.predecessor);
  assert(balance >= bet, ERR_INSUFFICIENT_BALANCE);

  const over = isOver ? context.predecessor : '';
  const under = isOver ? '' : context.predecessor;

  const wager = new Wager(wagerId(), symbol, value, at, bet, over, under);

  logging.log('Creating wager ' + wager.id.toString());

  balances.set(context.predecessor, u128.sub(balance, wager.bet));

  wagers.set(wager.id, wager);
  const userWagersList = userWagers.get(context.predecessor, [])!;
  userWagersList.push(wager.id);
  userWagers.set(context.predecessor, userWagersList);
  const symbolWagersList = symbols.get(wager.symbol, [])!;
  symbolWagersList.push(wager.id);
  symbols.set(wager.symbol, symbolWagersList);
}

export function transfer(to: AccountId, amount: u128): void {
  assert(amount > u128.Zero, ERR_INVALID_AMOUNT);
  assert(balances.contains(context.predecessor), ERR_INVALID_ACCOUNT);
  assert(env.isValidAccountID(to), ERR_INVALID_ACCOUNT);

  const balanceOfOwner = balances.getSome(context.predecessor);
  assert(balanceOfOwner >= amount, ERR_INSUFFICIENT_BALANCE);

  const balanceOfNewOwner = balances.get(to, u128.Zero)!;

  balances.set(context.predecessor, u128.sub(balanceOfOwner, amount));
  balances.set(to, u128.add(balanceOfNewOwner, amount));
}

export function getTotalSupply(): u128 {
  return TOTAL_SUPPLY;
}

export function getBalance(account: AccountId): u128 {
  assert(balances.contains(account), ERR_INVALID_ACCOUNT);
  return balances.getSome(account);
}

export function mint(): void {
  assert(!storage.contains('minted'), ERR_ALREADY_MINTED);
  storage.set<bool>('minted', true);

  storage.set<string>('oracle', context.predecessor);
  balances.set(context.predecessor, TOTAL_SUPPLY);
}
