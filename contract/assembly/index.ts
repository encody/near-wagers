//@nearfile out
import {
  context,
  env,
  logging,
  PersistentMap,
  PersistentSet,
  PersistentUnorderedMap,
  PersistentVector,
  storage,
  u128,
} from 'near-sdk-as';
import { MaxHeap } from './MaxHeap';
import { AccountId, SymbolId, Wager, WagerId } from './model';

const TOTAL_SUPPLY = u128.Max;
const MAX_SYMBOL_LENGTH = 128;

const ERR_ALREADY_MINTED = 'Already minted';
const ERR_INVALID_ACCOUNT = 'Invalid account';
const ERR_INVALID_AMOUNT = 'Invalid amount';
const ERR_INVALID_TIME = 'Invalid time';
const ERR_INVALID_WAGER = 'Invalid wager id';
const ERR_INVALID_SYMBOL = 'Invalid symbol';
const ERR_CANNOT_ACCEPT = 'Cannot accept wager';
const ERR_CANNOT_CANCEL = 'Cannot cancel wager';
const ERR_INSUFFICIENT_BALANCE = 'Insufficient balance';

function wagerId(): WagerId {
  const w = storage.getPrimitive<u64>('wagerId', 1);
  storage.set<u64>('wagerId', w + 1);
  return w;
}

@nearBindgen
class SortWagerByTime {
  constructor(public wagerId: WagerId, public at: u64) {}

  public static from(wager: Wager): SortWagerByTime {
    return new SortWagerByTime(wager.id, wager.at);
  }

  @operator('>')
  private __gt(right: SortWagerByTime): bool {
    return this.at < right.at;
  }

  @operator('==')
  private __eq(right: SortWagerByTime): bool {
    return this.wagerId == right.wagerId;
  }
}

const balances = new PersistentMap<AccountId, u128>('b');
const wagers = new PersistentMap<WagerId, Wager>('w');
const userWagers = new PersistentMap<AccountId, u64[]>('u');
const openWagers = new PersistentUnorderedMap<SymbolId, PersistentSet<WagerId>>(
  'ow',
);
const acceptedWagers = new PersistentMap<SymbolId, MaxHeap<SortWagerByTime>>(
  'aw',
);

export function getOracles(): string[] {
  return [storage.getString('oracle')!];
}

export function getSymbols(): string[] {
  return openWagers.keys();
}

export function getOpenWagersForSymbol(symbol: SymbolId): u64[] {
  if (openWagers.contains(symbol)) {
    return openWagers.getSome(symbol).values();
  } else {
    return [];
  }
}

export function getAcceptedWagersForSymbol(symbol: SymbolId): u64[] {
  if (acceptedWagers.contains(symbol)) {
    return acceptedWagers
      .getSome(symbol)
      .values()
      .map<WagerId>((w) => w.wagerId);
  } else {
    return [];
  }
}

export function getWagersForAccount(account: AccountId): u64[] {
  return userWagers.get(account, [])!;
}

export function getWager(wagerId: WagerId): Wager {
  assert(wagers.contains(wagerId), ERR_INVALID_WAGER);
  return wagers.getSome(wagerId);
}

export function NONSPEC_clearAccountWagers(account: AccountId): void {
  userWagers.delete(account);
}

export function NONSPEC_clearSymbolWagers(symbol: SymbolId): void {
  if (openWagers.contains(symbol)) {
    openWagers.getSome(symbol).clear();
    openWagers.delete(symbol);
  }
  if (acceptedWagers.contains(symbol)) {
    const heap = acceptedWagers.getSome(symbol);
    while (!heap.isEmpty) {
      heap.deleteAt(heap.length - 1);
    }
    acceptedWagers.delete(symbol);
  }
}

export function reportSymbol(symbol: SymbolId, value: u128): void {
  // TODO: Allow users to register as an oracle and specify an oracle in wagers so that wagers will only respond to symbols reported by a designated oracle.
  assert(
    storage.getString('oracle') == context.predecessor,
    ERR_INVALID_ACCOUNT,
  );
  const wagerIds = acceptedWagers.get(symbol);

  if (wagerIds != null) {
    while (!wagerIds.isEmpty) {
      const top = wagerIds.top;
      if (top.at < context.blockTimestamp) {
        const wager = wagers.getSome(top.wagerId);
        wagerIds.pop();
        distributeWinnings(wager, value);
        deleteWager(wager);
      } else {
        break;
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

export function cancelWager(wagerId: WagerId): void {
  assert(wagers.contains(wagerId), ERR_INVALID_WAGER);
  assert(userWagers.contains(context.predecessor), ERR_INVALID_ACCOUNT);

  const wager = wagers.getSome(wagerId);

  assert(
    // The wager has not been accepted...
    (wager.over == context.predecessor && wager.under == '') ||
      (wager.under == context.predecessor && wager.over == '') ||
      // or we are allowed to unilaterally cancel it
      (wager.allowCancelAt != 0 &&
        context.blockTimestamp > wager.allowCancelAt),
    ERR_CANNOT_CANCEL,
  );

  deleteWager(wager);
  const symbolOpenWagers = openWagers.getSome(wager.symbol);
  symbolOpenWagers.delete(wager.id);

  const balance = balances.getSome(context.predecessor);
  balances.set(context.predecessor, u128.add(balance, wager.bet));
}

function deleteWager(wager: Wager): void {
  const userWagersList = userWagers.getSome(context.predecessor);
  userWagersList.splice(userWagersList.indexOf(wager.id), 1);
  userWagers.set(context.predecessor, userWagersList);

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

  // Update balance
  balances.set(context.predecessor, u128.sub(balance, wager.bet));

  // Update wager
  wagers.set(wager.id, wager);

  const userWagersList = userWagers.get(context.predecessor, [])!;

  userWagersList.push(wager.id);

  userWagers.set(context.predecessor, userWagersList);

  // Remove from open wagers
  openWagers.getSome(wager.symbol).delete(wager.id);

  // Add to accepted wagers
  const swbt = SortWagerByTime.from(wager);
  const symbolAcceptedWagers = acceptedWagers.get(
    wager.symbol,
    new MaxHeap('aw-' + wager.symbol),
  )!;
  symbolAcceptedWagers.push(swbt);
}

export function createWager(
  symbol: SymbolId,
  isOver: boolean,
  value: u128,
  bet: u128,
  at: u64,
  allowCancelAt: u64 = 0,
): u64 {
  assert(bet > u128.Zero, ERR_INVALID_AMOUNT);
  assert(value > u128.Zero, ERR_INVALID_AMOUNT);
  assert(at > context.blockTimestamp, ERR_INVALID_TIME);
  assert(symbol.length <= MAX_SYMBOL_LENGTH, ERR_INVALID_SYMBOL);
  assert(balances.contains(context.predecessor), ERR_INVALID_ACCOUNT);
  const balance = balances.getSome(context.predecessor);
  assert(balance >= bet, ERR_INSUFFICIENT_BALANCE);

  const over = isOver ? context.predecessor : '';
  const under = isOver ? '' : context.predecessor;

  const wager = new Wager(
    wagerId(),
    symbol,
    value,
    at,
    allowCancelAt,
    bet,
    over,
    under,
  );

  logging.log('Creating wager ' + wager.id.toString());

  balances.set(context.predecessor, u128.sub(balance, wager.bet));

  wagers.set(wager.id, wager);
  const userWagersList = userWagers.get(context.predecessor, [])!;
  userWagersList.push(wager.id);
  userWagers.set(context.predecessor, userWagersList);

  const symbolOpenWagers = openWagers.get(
    wager.symbol,
    new PersistentSet('ow-' + wager.symbol),
  )!;
  symbolOpenWagers.add(wager.id);

  return wager.id;
}

export function transfer(to: AccountId, amount: u128): void {
  assert(amount > u128.Zero, ERR_INVALID_AMOUNT);
  assert(env.isValidAccountID(to), ERR_INVALID_ACCOUNT);
  assert(balances.contains(context.predecessor), ERR_INVALID_ACCOUNT);

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
  return balances.get(account, u128.Zero)!;
}

export function mint(): void {
  assert(!storage.contains('minted'), ERR_ALREADY_MINTED);
  storage.set<bool>('minted', true);

  storage.set<string>('oracle', context.predecessor);
  balances.set(context.predecessor, TOTAL_SUPPLY);
}
