import { DomainError } from '../../shared/domain/domain-error';
import { Money } from '../../shared/domain/money';

export enum LedgerDirection { Debit = 'DEBIT', Credit = 'CREDIT' }

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly #createdAt: number;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.#createdAt = state.createdAt.getTime();
    Object.freeze(this);
  }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    if (![state.id, state.walletId, state.transactionId].every(id => id.trim().length > 0)
      || !Number.isFinite(state.createdAt.getTime())
      || !Object.values(LedgerDirection).includes(state.direction)
      || !state.money.isPositive()
      || state.balanceBefore.isNegative() || state.balanceAfter.isNegative()) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'Invalid ledger entry fields');
    }
    const entry = new WalletLedgerEntry(state);
    if (!entry.isBalanced()) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'Ledger balances do not match the movement');
    }
    return entry;
  }

  /** Trusted persisted state; does not replay creation or transition rules. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry { return new WalletLedgerEntry(state); }

  get createdAt(): Date { return new Date(this.#createdAt); }

  isBalanced(): boolean {
    const expected = this.direction === LedgerDirection.Debit
      ? this.balanceBefore.subtract(this.money)
      : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
