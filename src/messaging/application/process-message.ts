import { createHash } from 'node:crypto';
import type { Database } from '../../shared/infrastructure/database';
import { PostgresWagerSession } from '../../wagering/infrastructure/postgres-wager-unit-of-work';
import { ProcessWagerUseCase } from '../../wagering/application/process-wager.use-case';
import { validateCommand, InvalidWagerInputError, IdempotencyConflictError } from '../../wagering/application/wager-command';
import type { WagerCommand } from '../../wagering/application/wager-command';
import type { WagerResult } from '../../wagering/application/wager-unit-of-work';
import { InboxMessage } from '../domain/messages';
import { count } from '../../shared/infrastructure/telemetry';

export interface WagerMessage { messageId:string; type:'WagerTransactionRequested'; occurredAt:string; data:WagerCommand }
export function parseMessage(body: string): WagerMessage {
  let m: WagerMessage;
  try { m=JSON.parse(body) as WagerMessage; } catch { throw new InvalidWagerInputError('Invalid JSON'); }
  if (!m || typeof m.messageId!=='string' || !m.messageId.trim() || m.messageId.length>200 || m.type!=='WagerTransactionRequested'
    || typeof m.occurredAt!=='string' || !Number.isFinite(Date.parse(m.occurredAt)) || !m.data) throw new InvalidWagerInputError('Invalid envelope');
  validateCommand(m.data);
  return m;
}
export async function processMessage(db:Database, message:WagerMessage, exhausted=false):Promise<WagerResult> {
  const {hash}=validateCommand(message.data);
  // Include key: an envelope ID cannot be reused for a different request key.
  const envelopeHash=createHash('sha256').update(JSON.stringify([hash,message.data.idempotencyKey])).digest('hex');
  try {return await db.em.fork().transactional(async em=>{
    await em.execute('select pg_advisory_xact_lock(hashtextextended(?,0))',[JSON.stringify(['inbox','wager-consumer',message.messageId])]);
    const previous=await em.execute<Array<{payload_hash:string;result:WagerResult}>>('select payload_hash,result from inbox_messages where consumer_name=? and message_id=?',['wager-consumer',message.messageId]);
    if(previous[0]) {
      if(previous[0].payload_hash!==envelopeHash) throw new IdempotencyConflictError('Inbox payload conflict');
      return {...previous[0].result,idempotentReplay:true};
    }
    const useCase=new ProcessWagerUseCase({run:work=>work(new PostgresWagerSession(em))});
    const result=await useCase.execute(message.data,{correlationId:message.messageId,causationId:message.messageId},exhausted);
    const inbox=InboxMessage.receive('wager-consumer',message.messageId,envelopeHash);inbox.markProcessed(new Date());
    await em.execute('insert into inbox_messages(consumer_name,message_id,payload_hash,result,received_at,processed_at) values(?,?,?,?::jsonb,?,?)',
      [inbox.consumerName,inbox.messageId,inbox.payloadHash,JSON.stringify(result),inbox.receivedAt,inbox.processedAt]);
    return result;
  });}catch(error:unknown){if(['55P03','40P01','40001'].includes((error as {code?:string}).code??''))count('lock_conflicts_total');throw error;}
}
