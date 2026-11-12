import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import type { MoneyProps } from '../../shared/domain/money';
import type { IntegrationEvent } from '../../messaging/domain/integration-event';
import type { WagerTransaction, FailureCode, WagerReference } from '../domain/wager-transaction';
import type { EventContext } from '../../messaging/domain/integration-event';

export interface WagerResult {
  transactionId: string; status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED'; balance: MoneyProps;
  idempotentReplay: boolean; failureCode?: FailureCode;
}
export interface StoredWager { payloadHash: string; result: WagerResult }
export type ReferenceWager = WagerReference;
export interface PendingSchedule { attempts: number; nextAttemptAt: Date; expiresAt: Date; context: EventContext }
export interface PendingWager { transaction: WagerTransaction; schedule: PendingSchedule }
export interface WagerSession {
  lockIdentity(provider: string, key: string, externalId: string): Promise<void>;
  findKey(provider: string, key: string): Promise<StoredWager | null>;
  findExternal(provider: string, externalId: string): Promise<StoredWager | null>;
  saveKey(provider: string, key: string, hash: string, result: WagerResult): Promise<void>;
  lockWallet(id: string): Promise<Wallet | null>;
  findReference(provider: string, externalId: string): Promise<ReferenceWager | null>;
  hasReversal(referenceId: string, kind: string): Promise<boolean>;
  claimPending(at: Date): Promise<PendingWager | null>;
  reschedule(id: string, schedule: PendingSchedule): Promise<void>;
  save(transaction: WagerTransaction, wallet: Wallet, entry: WalletLedgerEntry | undefined,
    result: WagerResult, events: IntegrationEvent<Record<string, unknown>>[], at: Date,
    pending?: PendingSchedule, update?: boolean): Promise<void>;
}
export interface WagerUnitOfWork { run<T>(work: (session: WagerSession) => Promise<T>): Promise<T> }
