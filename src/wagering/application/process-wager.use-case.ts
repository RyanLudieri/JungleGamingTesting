import { DomainError } from '../../shared/domain/domain-error';
import { WagerTransaction } from '../domain/wager-transaction';
import type { FailureCode, WagerReference } from '../domain/wager-transaction';
import { validateCommand, IdempotencyConflictError, InvalidWagerInputError } from './wager-command';
import type { WagerCommand } from './wager-command';
import type { WagerResult, WagerUnitOfWork, WagerSession, PendingSchedule } from './wager-unit-of-work';
import { WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionFailed, WalletBalanceChanged, WagerTransactionPendingReference } from '../../messaging/domain/integration-event';
import type { EventContext, IntegrationEvent } from '../../messaging/domain/integration-event';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import type { Wallet } from '../../wallet/domain/wallet';
import { defaultReferencePolicy, validateReferencePolicy, nextReferenceAttempt } from './reference-policy';
import type { ReferencePolicy } from './reference-policy';
import { log, count } from '../../shared/infrastructure/telemetry';

export class ProcessWagerUseCase {
  private readonly policy: ReferencePolicy;
  constructor(private readonly unitOfWork: WagerUnitOfWork, policy: ReferencePolicy = defaultReferencePolicy,
    private readonly now: () => Date = () => new Date()) { this.policy = validateReferencePolicy(policy); }

  async execute(input: WagerCommand, context: EventContext = { correlationId: crypto.randomUUID() }, exhausted = false): Promise<WagerResult> {
    const { command: c, money, hash } = validateCommand(input);
    return this.unitOfWork.run(async session => {
      await session.lockIdentity(c.providerId, c.idempotencyKey, c.externalTransactionId);
      const original = await session.findKey(c.providerId, c.idempotencyKey) ?? await session.findExternal(c.providerId, c.externalTransactionId);
      if (original) {
        if (original.payloadHash !== hash) throw new IdempotencyConflictError('Operation identity already has a different payload');
        await session.saveKey(c.providerId, c.idempotencyKey, hash, original.result);
        return { ...original.result, idempotentReplay: true };
      }
      const wallet = await session.lockWallet(c.walletId);
      if (!wallet) throw new InvalidWagerInputError('Wallet does not exist');
      const tx = WagerTransaction.create({ ...c, money, id: crypto.randomUUID(), payloadHash: hash });
      let result: WagerResult;
      if(exhausted) {
        tx.fail('INFRASTRUCTURE_RETRIES_EXHAUSTED');
        result={transactionId:tx.props.id,status:'FAILED',failureCode:tx.failureCode!,balance:wallet.balance.toJSON(),idempotentReplay:false};
        const at=this.now();
        await session.save(tx,wallet,undefined,result,[new WagerTransactionFailed(wallet.id,context,at,{...result,providerId:c.providerId,externalTransactionId:c.externalTransactionId})],at);
      }else result = await this.process(session,tx,wallet,context,this.now());
      await session.saveKey(c.providerId,c.idempotencyKey,hash,result);
      return result;
    });
  }

  /** Processes one due row under a database lock; public replay never invokes this. */
  async retryOne(): Promise<boolean> {
    return this.unitOfWork.run(async session => {
      const at = this.now();
      const pending = await session.claimPending(at);
      if (!pending) return false;
      const wallet = await session.lockWallet(pending.transaction.props.walletId);
      if (!wallet) throw new Error('Persisted pending transaction has no wallet');
      const result=await this.process(session,pending.transaction,wallet,pending.schedule.context,at,pending.schedule);
      count('reference_retries_total');
      log('reference_retry',{correlationId:pending.schedule.context.correlationId,transactionId:result.transactionId,walletId:wallet.id,
        providerId:pending.transaction.props.providerId,status:result.status});
      return true;
    });
  }

  private async process(session: WagerSession, tx: WagerTransaction, wallet: Wallet,
    context: EventContext, at: Date, existing?: PendingSchedule): Promise<WagerResult> {
    const p = tx.props;
    let rejection: FailureCode | undefined;
    let reference: WagerReference | undefined;
    let waiting = false;
    if (existing && at>=existing.expiresAt) rejection='REFERENCE_NOT_FOUND';
    else if (wallet.playerId!==p.playerId) rejection='PLAYER_MISMATCH';
    else if (wallet.currency!==p.money.currency) rejection='CURRENCY_MISMATCH';
    else if (p.referenceExternalTransactionId!==undefined) {
      reference = await session.findReference(p.providerId,p.referenceExternalTransactionId) ?? undefined;
      rejection = reference ? tx.referenceFailure(reference) : undefined;
      waiting = !rejection && (!reference || reference.status!=='PROCESSED');
      if (!waiting && !rejection && reference && tx.isReversal && await session.hasReversal(reference.id,p.kind)) rejection='ALREADY_REVERSED';
    }
    let schedule: PendingSchedule | undefined;
    let entry: WalletLedgerEntry | undefined;
    if (rejection) tx.reject(rejection);
    else if (waiting) {
      tx.markPendingReference();
      const expiresAt = existing?.expiresAt ?? new Date(at.getTime()+this.policy.ttlMs);
      const attempts = existing ? existing.attempts+1 : 0;
      schedule = {attempts,expiresAt,nextAttemptAt:nextReferenceAttempt(at,attempts,expiresAt,this.policy),context};
    } else {
      try { entry=tx.apply(wallet,at,reference); }
      catch(error: unknown) {
        if (!(error instanceof DomainError) || !['INSUFFICIENT_BALANCE','MONEY_OUT_OF_RANGE'].includes(error.code)) throw error;
        tx.reject(error.code==='INSUFFICIENT_BALANCE' && tx.isReversal ? 'REVERSAL_INSUFFICIENT_BALANCE' : error.code as FailureCode);
      }
    }
    const result: WagerResult = {transactionId:p.id,status:tx.status as WagerResult['status'],balance:wallet.balance.toJSON(),
      idempotentReplay:false,...(tx.failureCode===undefined?{}:{failureCode:tx.failureCode})};
    if (existing && schedule) { await session.reschedule(p.id,schedule); return result; }
    const data = {providerId:p.providerId,externalTransactionId:p.externalTransactionId,walletId:p.walletId,kind:p.kind,...result};
    const events: IntegrationEvent<Record<string,unknown>>[] = [tx.status==='PENDING_REFERENCE'
      ? new WagerTransactionPendingReference(wallet.id,context,at,data) : tx.status==='PROCESSED'
      ? new WagerTransactionProcessed(wallet.id,context,at,data) : new WagerTransactionRejected(wallet.id,context,at,data)];
    if (entry) events.push(new WalletBalanceChanged(wallet.id,context,at,{walletId:wallet.id,transactionId:p.id,
      direction:entry.direction,money:entry.money.toJSON(),balanceBefore:entry.balanceBefore.toJSON(),
      balanceAfter:entry.balanceAfter.toJSON(),walletVersion:wallet.version}));
    await session.save(tx,wallet,entry,result,events,at,schedule,existing!==undefined);
    return result;
  }
}
