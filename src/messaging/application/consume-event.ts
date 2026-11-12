import { createHash } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { Database } from '../../shared/infrastructure/database';
import { IdempotencyConflictError, InvalidWagerInputError } from '../../wagering/application/wager-command';
/** Downstream template: the projection callback and event inbox share one SQL transaction. Ack only after this returns. */
export async function consumeEvent(db:Database,consumerName:string,event:{eventId:string;[key:string]:unknown},
  apply:(em:EntityManager)=>Promise<void>):Promise<boolean>{
  if(!event||typeof event.eventId!=='string'||!event.eventId)throw new InvalidWagerInputError('Invalid event ID');
  const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
  const hash=createHash('sha256').update(JSON.stringify(canonical(event))).digest('hex');
  return db.em.fork().transactional(async em=>{
    await em.execute('select pg_advisory_xact_lock(hashtextextended(?,0))',[JSON.stringify(['inbox',consumerName,event.eventId])]);
    const rows=await em.execute<Array<{payload_hash:string}>>('select payload_hash from inbox_messages where consumer_name=? and message_id=?',[consumerName,event.eventId]);
    if(rows[0]){if(rows[0].payload_hash!==hash)throw new IdempotencyConflictError('Event ID payload conflict');return false;}
    await apply(em);
    await em.execute('insert into inbox_messages(consumer_name,message_id,payload_hash,result) values(?,?,?,?::jsonb)',[consumerName,event.eventId,hash,'{}']);return true;
  });
}
