import { u128 } from 'near-sdk-as';

export type AccountId = string;
export type WagerId = u64;
export type SymbolId = string;

@nearBindgen
export class Wager {
  constructor(
    public id: WagerId,
    public symbol: SymbolId,
    public value: u128,
    public at: u64,
    public allowCancelAt: u64,
    public bet: u128,
    public over: AccountId,
    public under: AccountId,
  ) {}
}
