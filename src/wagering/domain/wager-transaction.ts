import { Money } from '../../shared/domain/money';
import { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';

export type WagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type WagerStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export type FailureCode = 'INSUFFICIENT_BALANCE' | 'CURRENCY_MISMATCH' | 'PLAYER_MISMATCH'
  | 'MONEY_OUT_OF_RANGE' | 'INVALID_REFERENCE' | 'ALREADY_REVERSED'
  | 'REVERSAL_INSUFFICIENT_BALANCE' | 'REFERENCE_NOT_FOUND' | 'INFRASTRUCTURE_RETRIES_EXHAUSTED';
export interface WagerReference {
  id: string; walletId: string; playerId: string; currency: string; roundId: string;
  kind: string; status: string; amount: string;
}
export interface WagerProps {
  id: string; providerId: string; externalTransactionId: string; idempotencyKey: string;
  payloadHash: string; walletId: string; playerId: string; roundId: string; gameId: string;
  kind: WagerKind; money: Money; referenceExternalTransactionId?: string;
}
export interface WagerState extends WagerProps {
  status: WagerStatus; failureCode?: FailureCode; referenceTransactionId?: string;
}

export class WagerTransaction {
  readonly props: Readonly<WagerProps>;
  #status: WagerStatus;
  #failureCode: FailureCode | undefined;
  #referenceTransactionId: string | undefined;
  private constructor(props: WagerProps, status: WagerStatus, failureCode?: FailureCode, referenceTransactionId?: string) {
    this.props = Object.freeze({ ...props });
    this.#status = status;
    this.#failureCode = failureCode;
    this.#referenceTransactionId = referenceTransactionId;
    Object.freeze(this);
  }
  static create(props: WagerProps): WagerTransaction {
    if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(props.kind) || props.money.isNegative()
      || (props.kind !== 'LOSS' && !props.money.isPositive())
      || (props.referenceExternalTransactionId !== undefined && !['WIN','REFUND','ROLLBACK'].includes(props.kind))
      || (['REFUND','ROLLBACK'].includes(props.kind) && !props.referenceExternalTransactionId)) {
      throw new Error('Invalid wager operation');
    }
    return new WagerTransaction(props, 'PENDING');
  }
  static rehydrate(state: WagerState): WagerTransaction {
    const { status, failureCode, referenceTransactionId, ...props } = state;
    return new WagerTransaction(props, status, failureCode, referenceTransactionId);
  }
  get status(): WagerStatus { return this.#status; }
  get failureCode(): FailureCode | undefined { return this.#failureCode; }
  get referenceTransactionId(): string | undefined { return this.#referenceTransactionId; }
  get isReversal(): boolean { return this.props.kind === 'REFUND' || this.props.kind === 'ROLLBACK'; }
  private assertPending(): void {
    if (!['PENDING','PENDING_REFERENCE'].includes(this.#status)) throw new Error('Invalid transaction state: terminal');
  }
  markPendingReference(): void { this.assertPending(); this.#status = 'PENDING_REFERENCE'; }
  referenceFailure(ref: WagerReference): FailureCode | undefined {
    const p = this.props;
    const allowed = p.kind === 'ROLLBACK' ? ['BET','WIN','REFUND'] : ['BET'];
    if (ref.walletId !== p.walletId || ref.playerId !== p.playerId || ref.currency !== p.money.currency
      || ref.roundId !== p.roundId || !allowed.includes(ref.kind)
      || ['REJECTED','FAILED'].includes(ref.status)) return 'INVALID_REFERENCE';
    if (this.isReversal && !p.money.equals(Money.from({amount:ref.amount,currency:ref.currency}))) return 'INVALID_REFERENCE';
    return undefined;
  }
  reject(code: FailureCode): void {
    this.assertPending(); this.#failureCode = code; this.#status = 'REJECTED';
  }
  fail(code: FailureCode): void { this.assertPending(); this.#failureCode=code; this.#status='FAILED'; }
  apply(wallet: Wallet, at: Date, reference?: WagerReference): WalletLedgerEntry | undefined {
    this.assertPending();
    if (this.props.referenceExternalTransactionId !== undefined && (!reference
      || reference.status !== 'PROCESSED' || this.referenceFailure(reference))) throw new Error('Invalid reference for application');
    const context = { entryId: crypto.randomUUID(), transactionId: this.props.id, at };
    const debit = this.props.kind === 'BET' || (this.props.kind === 'ROLLBACK' && reference?.kind !== 'BET');
    const entry = this.props.kind === 'LOSS' ? undefined : debit
      ? wallet.debit(this.props.money, context) : wallet.credit(this.props.money, context);
    this.#referenceTransactionId = reference?.id;
    this.#status = 'PROCESSED';
    return entry;
  }
}
