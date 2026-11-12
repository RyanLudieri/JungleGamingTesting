import { DomainError } from '../../shared/domain/domain-error';
import { Money } from '../../shared/domain/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementContext {
  entryId: string;
  transactionId: string;
  at: Date;
}

export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  #balance: Money;
  #version: number;
  readonly #createdAt: number;
  #updatedAt: number;

  private constructor(state: WalletState) {
    this.id = state.id;
    this.playerId = state.playerId;
    this.currency = state.currency;
    this.#balance = state.balance;
    this.#version = state.version;
    this.#createdAt = state.createdAt.getTime();
    this.#updatedAt = state.updatedAt.getTime();
    // Public identity is immutable; private slots remain controlled by methods.
    Object.freeze(this);
  }

  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    if (!props.id.trim() || !props.playerId.trim() || props.initialBalance.isNegative()
      || !Number.isFinite(props.at.getTime())) {
      throw new DomainError('INVALID_WALLET', 'Invalid wallet opening state');
    }
    return new Wallet({ id: props.id, playerId: props.playerId,
      currency: props.initialBalance.currency, balance: props.initialBalance,
      version: 1, createdAt: props.at, updatedAt: props.at });
  }

  /** Trusted persisted state; no opening movement or version increment. */
  static rehydrate(state: WalletState): Wallet { return new Wallet(state); }

  get balance(): Money { return this.#balance; }
  get version(): number { return this.#version; }
  get createdAt(): Date { return new Date(this.#createdAt); }
  get updatedAt(): Date { return new Date(this.#updatedAt); }

  debit(money: Money, context: MovementContext): WalletLedgerEntry {
    return this.move(money, LedgerDirection.Debit, context);
  }

  credit(money: Money, context: MovementContext): WalletLedgerEntry {
    return this.move(money, LedgerDirection.Credit, context);
  }

  private move(money: Money, direction: LedgerDirection, context: MovementContext): WalletLedgerEntry {
    if (money.currency !== this.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Movement currency must match wallet');
    }
    if (!money.isPositive()) {
      throw new DomainError('INVALID_AMOUNT', 'Movement must be positive');
    }
    if (direction === LedgerDirection.Debit && this.#balance.isLessThan(money)) {
      throw new DomainError('INSUFFICIENT_BALANCE', 'Wallet has insufficient balance');
    }
    if (!Number.isSafeInteger(this.#version + 1)) {
      throw new DomainError('INVALID_MOVEMENT', 'Wallet version limit reached');
    }
    const balanceAfter = direction === LedgerDirection.Debit
      ? this.#balance.subtract(money) : this.#balance.add(money);
    const entry = WalletLedgerEntry.create({ id: context.entryId, walletId: this.id,
      transactionId: context.transactionId, direction, money,
      balanceBefore: this.#balance, balanceAfter, createdAt: context.at });
    // Commit in-memory state only after every fallible validation has succeeded.
    this.#balance = balanceAfter;
    this.#version += 1;
    this.#updatedAt = context.at.getTime();
    return entry;
  }
}
