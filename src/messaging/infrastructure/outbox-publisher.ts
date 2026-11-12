import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { Database } from '../../shared/infrastructure/database';
import { count } from '../../shared/infrastructure/telemetry';
import { OutboxMessage } from '../domain/messages';

/** Keep the row lock until publish completes. A crash rolls back the marker; the stable event ID makes redelivery safe. */
export async function publishOne(db:Database,sqs:SQSClient,url:string):Promise<boolean> {
  return db.em.fork().transactional(async em=>{
    const rows=await em.execute<Array<{id:string;aggregate_id:string;event_type:string;occurred_at:string;payload:Record<string,unknown>;attempts:number}>>(`select * from outbox_messages
      where published_at is null and (next_attempt_at is null or next_attempt_at<=now()) order by occurred_at,id limit 1 for update skip locked`);
    const row=rows[0]; if(!row) return false;
    const message=OutboxMessage.rehydrate({id:row.id,aggregateId:row.aggregate_id,eventType:row.event_type,payload:row.payload,occurredAt:new Date(row.occurred_at),attempts:row.attempts});
    try {
      await sqs.send(new SendMessageCommand({QueueUrl:url,MessageBody:JSON.stringify(row.payload),MessageGroupId:row.aggregate_id,MessageDeduplicationId:row.id}));
      await em.execute('update outbox_messages set published_at=now(),attempts=attempts+1 where id=?',[row.id]);
    } catch {
      count('outbox_retries_total');
      message.scheduleRetry(new Date());
      await em.execute('update outbox_messages set attempts=?,next_attempt_at=? where id=?',[message.attempts,message.nextAttemptAt,row.id]);
    }
    return true;
  });
}
