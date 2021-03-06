import { u128, VMContext } from 'near-sdk-as';
import {
  getAcceptedWagersForSymbol,
  getBalance,
  getOpenWagersForSymbol,
  getOracles,
  getSymbols,
  getTotalSupply,
  getWager,
  getWagersForAccount,
  mint,
  transfer,
} from '..';

const BTC = 'BTC';
const alice = 'alice';
const bob = 'bob';

describe('wagers contract', () => {
  it('works when empty', () => {
    expect(getSymbols().length).toBe(0);
    expect(getOpenWagersForSymbol(BTC).length).toBe(0);
    expect(getAcceptedWagersForSymbol(BTC).length).toBe(0);
    expect(getWagersForAccount(alice).length).toBe(0);
    expect(getTotalSupply()).toBe(u128.Max);
    expect(getSymbols().length).toBe(0);
    expect(getBalance(alice)).toBe(u128.Zero);

    expect(() => {
      getWager(1);
    }).toThrow();
  });

  it('mints', () => {
    VMContext.setPredecessor_account_id(alice);
    expect(() => {
      mint();
    }).not.toThrow();

    const oracles = getOracles();
    expect(oracles.length).toBe(1);
    expect(oracles[0]).toBe(alice);

    expect(getBalance(alice)).toBe(u128.Max);

    expect(() => {
      mint();
    }).toThrow();
  });

  it('transfers', () => {
    VMContext.setPredecessor_account_id(alice);
    mint();

    expect(getBalance(alice)).toBe(u128.Max);
    expect(getBalance(bob)).toBe(u128.Zero);

    VMContext.setPredecessor_account_id(bob);
    expect(() => {
      transfer(alice, u128.One);
    }).toThrow('Cannot transfer from empty account');

    const amount = new u128(20);

    VMContext.setPredecessor_account_id(alice);
    transfer(bob, amount);

    expect(getBalance(alice)).toBe(u128.sub(u128.Max, amount));
    expect(getBalance(bob)).toBe(amount);

    expect(() => {
      VMContext.setPredecessor_account_id(alice);
      transfer(bob, u128.Zero);
    }).toThrow('Transfer zero');
    expect(() => {
      VMContext.setPredecessor_account_id(alice);
      transfer('definitely invalid address...', u128.One);
    }).toThrow('Transfer to invalid address');
  });
});
