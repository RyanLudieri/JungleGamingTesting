import type { EntityManager } from '@mikro-orm/postgresql';
import type { Database } from '../../shared/infrastructure/database';
import { Money } from '../../shared/domain/money';
import { Wallet } from '../../wallet/domain/wallet';
import { WalletEntity } from '../../wallet/infrastructure/entities';
import { LockMode } from '@mikro-orm/core';
import type { WagerUnitOfWork, WagerSession, WagerResult, StoredWager, ReferenceWager, PendingSchedule, PendingWager } from '../application/wager-unit-of-work';
import { WagerTransaction } from '../domain/wager-transaction';
import type { WagerKind } from '../domain/wager-transaction';
import type { EventContext } from '../../messaging/domain/integration-event';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import type { IntegrationEvent } from '../../messaging/domain/integration-event';
import { OutboxMessage } from '../../messaging/domain/messages';
import { count } from '../../shared/infrastructure/telemetry';

export class PostgresWagerSession implements WagerSession {
  constructor(private readonly em: EntityManager) {}
  async lockIdentity(provider: string, key: string, externalId: string): Promise<void> {
    // Separate namespaces; every operation acquires key, external identity, then wallet.
    for (const identity of [['key',provider,key], ['external',provider,externalId]]) {
      await this.em.execute('select pg_advisory_xact_lock(hashtextextended(?,0))', [JSON.stringify(identity)]);
    }
  }
  async findKey(provider: string, key: string): Promise<StoredWager | null> {
    const rows = await this.em.execute<StoredWager[]>(`select t.payload_hash as "payloadHash",t.result
      from wager_idempotency i join wager_transactions t on t.id=i.transaction_id
      where i.provider_id=? and i.idempotency_key=?`, [provider,key]);
    return rows[0] ?? null;
  }
  async findExternal(provider: string, externalId: string): Promise<StoredWager | null> {
    const rows = await this.em.execute<StoredWager[]>(`select payload_hash as "payloadHash", result
      from wager_transactions where provider_id=? and external_transaction_id=?`, [provider,externalId]);
    return rows[0] ?? null;
  }
  async saveKey(provider: string, key: string, hash: string, result: WagerResult): Promise<void> {
    await this.em.execute(`insert into wager_idempotency(provider_id,idempotency_key,payload_hash,transaction_id)
      values(?,?,?,?) on conflict(provider_id,idempotency_key) do nothing`, [provider,key,hash,result.transactionId]);
  }
  async lockWallet(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return row ? Wallet.rehydrate({ ...row, balance: Money.from({ amount: row.balance, currency: row.currency }) }) : null;
  }
  async findReference(provider: string, externalId: string): Promise<ReferenceWager | null> {
    const rows = await this.em.execute<ReferenceWager[]>(`select id,wallet_id as "walletId",player_id as "playerId",
      currency,amount,round_id as "roundId",kind,status from wager_transactions where provider_id=? and external_transaction_id=?`, [provider,externalId]);
    return rows[0] ?? null;
  }
  async hasReversal(referenceId: string, kind: string): Promise<boolean> {
    const rows = await this.em.execute<unknown[]>('select id from wager_transactions where reference_transaction_id=? and kind=? and status=?',
      [referenceId,kind,'PROCESSED']);
    return rows.length>0;
  }
  async claimPending(at: Date): Promise<PendingWager | null> {
    const rows = await this.em.execute<Array<{
      id:string;provider_id:string;external_transaction_id:string;idempotency_key:string;payload_hash:string;
      wallet_id:string;player_id:string;round_id:string;game_id:string;kind:WagerKind;amount:string;currency:string;
      reference_external_transaction_id:string;reference_attempts:number;next_attempt_at:string;expires_at:string;event_context:EventContext;
    }>>(`select * from wager_transactions where status='PENDING_REFERENCE' and (next_attempt_at<=? or expires_at<=?)
      order by next_attempt_at,id limit 1 for update skip locked`,[at,at]);
    const row = rows[0]; if (!row) return null;
    return {transaction:WagerTransaction.rehydrate({id:row.id,providerId:row.provider_id,externalTransactionId:row.external_transaction_id,
      idempotencyKey:row.idempotency_key,payloadHash:row.payload_hash,walletId:row.wallet_id,playerId:row.player_id,
      roundId:row.round_id,gameId:row.game_id,kind:row.kind,money:Money.from({amount:row.amount,currency:row.currency}),
      referenceExternalTransactionId:row.reference_external_transaction_id,status:'PENDING_REFERENCE'}),
      schedule:{attempts:row.reference_attempts,nextAttemptAt:new Date(row.next_attempt_at),expiresAt:new Date(row.expires_at),context:row.event_context}};
  }
  async reschedule(id: string, schedule: PendingSchedule): Promise<void> {
    await this.em.execute('update wager_transactions set reference_attempts=?,next_attempt_at=? where id=?',
      [schedule.attempts,schedule.nextAttemptAt,id]);
  }
  async save(tx: WagerTransaction, wallet: Wallet, entry: WalletLedgerEntry | undefined,
    result: WagerResult, events: IntegrationEvent<Record<string, unknown>>[], at: Date,
    pending?: PendingSchedule, update = false): Promise<void> {
    const p = tx.props;
    if (update) {
      await this.em.execute(`update wager_transactions set status=?,failure_code=?,current_result=?::jsonb,
        processed_at=?,reference_transaction_id=?,next_attempt_at=null,reference_attempts=reference_attempts+1 where id=?`,
        [tx.status,tx.failureCode??null,JSON.stringify(result),at,tx.referenceTransactionId??null,p.id]);
    } else await this.em.execute(`insert into wager_transactions(id,wallet_id,player_id,currency,amount,kind,status,created_at,
      provider_id,external_transaction_id,idempotency_key,payload_hash,round_id,game_id,reference_external_transaction_id,
      failure_code,result,processed_at,current_result,reference_transaction_id,reference_attempts,next_attempt_at,expires_at,event_context)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?::jsonb,?,?,?,?,?::jsonb)`,
    [p.id,p.walletId,p.playerId,p.money.currency,p.money.toString(),p.kind,tx.status,at,
      p.providerId,p.externalTransactionId,p.idempotencyKey,p.payloadHash,p.roundId,p.gameId,
      p.referenceExternalTransactionId ?? null,tx.failureCode ?? null,JSON.stringify(result),pending?null:at,
      JSON.stringify(result),tx.referenceTransactionId??null,pending?.attempts??0,pending?.nextAttemptAt??null,
      pending?.expiresAt??null,JSON.stringify(pending?.context??events[0]?.context??{})]);
    if (entry) {
      await this.em.execute('update wallets set balance=?,version=?,updated_at=? where id=?',
        [wallet.balance.toString(),wallet.version,wallet.updatedAt,wallet.id]);
      await this.em.execute(`insert into wallet_ledger_entries(id,wallet_id,transaction_id,currency,amount,direction,
        balance_before,balance_after,wallet_version,created_at) values(?,?,?,?,?,?,?,?,?,?)`,
      [entry.id,wallet.id,p.id,entry.money.currency,entry.money.toString(),entry.direction,
        entry.balanceBefore.toString(),entry.balanceAfter.toString(),wallet.version,at]);
    }
    for (const event of events) {
      const message=OutboxMessage.enqueue(event);
      await this.em.execute(`insert into outbox_messages(id,aggregate_id,transaction_id,event_type,payload,occurred_at)
        values(?,?,?,?,?::jsonb,?)`, [message.id,message.aggregateId,p.id,message.eventType,JSON.stringify(message.payload),message.occurredAt]);
    }
  }
}

export class PostgresWagerUnitOfWork implements WagerUnitOfWork {
  constructor(private readonly orm: Database) {}
  async run<T>(work: (session: WagerSession) => Promise<T>): Promise<T> {
    try {return await this.orm.em.fork().transactional(em => work(new PostgresWagerSession(em)));}
    catch(error:unknown){if(['55P03','40P01','40001'].includes((error as {code?:string}).code??''))count('lock_conflicts_total');throw error;}
  }
}
