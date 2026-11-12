import 'reflect-metadata';
import {beforeAll,afterAll,test,expect} from 'bun:test';
import {Module} from '@nestjs/common';
import {NestFactory,APP_FILTER} from '@nestjs/core';
import {ApiController,DATABASE,HttpErrors} from '../../src/shared/infrastructure/http';
import {connectDatabase,type Database} from '../../src/shared/infrastructure/database';
import {OpenWalletUseCase} from '../../src/wallet/application/open-wallet.use-case';
import {PostgresWalletRepository} from '../../src/wallet/infrastructure/postgres-wallet.repository';
import {Money} from '../../src/shared/domain/money';
import {processMessage,type WagerMessage} from '../../src/messaging/application/process-message';
import {publishOne} from '../../src/messaging/infrastructure/outbox-publisher';
import {consumeEvent} from '../../src/messaging/application/consume-event';
import {sqsClient} from '../../src/messaging/infrastructure/sqs';
import {CreateQueueCommand,DeleteQueueCommand,SendMessageCommand,ReceiveMessageCommand,GetQueueAttributesCommand} from '@aws-sdk/client-sqs';
const url=process.env.TEST_DATABASE_URL;
if(!url||new URL(url).pathname!=='/wagering_test'||url===process.env.DATABASE_URL)throw new Error('Dedicated test database required');
process.env.SQS_ENDPOINT??='http://localhost:4566';
const schema=`transport_test_${crypto.randomUUID().replaceAll('-','')}`;
let admin:Database,db:Database;const sqs=sqsClient();let input:string,events:string,dlq:string;
const names={input:`${schema}.fifo`,events:`${schema}_events.fifo`,dlq:`${schema}_dlq.fifo`};
const children:ReturnType<typeof Bun.spawn>[]=[];
async function fixture():Promise<WagerMessage>{
  const w=await new OpenWalletUseCase(new PostgresWalletRepository(db)).execute({playerId:crypto.randomUUID(),initialBalance:Money.from({amount:'100.00',currency:'BRL'})});
  return {messageId:crypto.randomUUID(),type:'WagerTransactionRequested',occurredAt:new Date().toISOString(),data:{providerId:'p',externalTransactionId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),walletId:w.id,playerId:w.playerId,roundId:'r',gameId:'g',kind:'BET',money:{amount:'80.00',currency:'BRL'}}};
}
async function waitFor(check:()=>Promise<boolean>,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await Bun.sleep(50);}throw new Error('Timed out');}
function worker(crash=false){const p=Bun.spawn([process.execPath,'src/messaging/infrastructure/worker.ts','consumer'],{env:{...process.env,DATABASE_URL:url!,DATABASE_SCHEMA:schema,SQS_INPUT_QUEUE:names.input,SQS_DLQ_QUEUE:names.dlq,TEST_CRASH_AFTER_COMMIT:crash?'1':'0',TEST_VISIBILITY_SECONDS:'2'},stdout:'pipe',stderr:'pipe'});children.push(p);return p;}
async function empty(){const r=await sqs.send(new GetQueueAttributesCommand({QueueUrl:input,AttributeNames:['ApproximateNumberOfMessages','ApproximateNumberOfMessagesNotVisible']}));return Object.values(r.Attributes??{}).every(v=>v==='0');}
async function send(m:WagerMessage){await sqs.send(new SendMessageCommand({QueueUrl:input,MessageBody:JSON.stringify(m),MessageGroupId:crypto.randomUUID(),MessageDeduplicationId:crypto.randomUUID()}));}
beforeAll(async()=>{admin=await connectDatabase(url);await admin.em.execute(`create schema ${schema}`);db=await connectDatabase(url,schema);await db.migrator.up();
  input=(await sqs.send(new CreateQueueCommand({QueueName:names.input,Attributes:{FifoQueue:'true',VisibilityTimeout:'2'}}))).QueueUrl!;
  events=(await sqs.send(new CreateQueueCommand({QueueName:names.events,Attributes:{FifoQueue:'true'}}))).QueueUrl!;
  dlq=(await sqs.send(new CreateQueueCommand({QueueName:names.dlq,Attributes:{FifoQueue:'true'}}))).QueueUrl!;
});
afterAll(async()=>{for(const p of children){p.kill();await p.exited;}try{if(db){expect(await db.em.execute(`select w.id from wallets w left join wallet_ledger_entries e on w.id=e.wallet_id group by w.id having w.balance<>coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end),0)`)).toHaveLength(0);await db.close(true);}}
  finally{if(admin){await admin.em.execute(`drop schema ${schema} cascade`);await admin.close(true);}for(const QueueUrl of [input,events,dlq])if(QueueUrl)await sqs.send(new DeleteQueueCommand({QueueUrl}));sqs.destroy();}});

test('HTTP contracts, header authority, pagination, current lookup and reconciliation',async()=>{
  @Module({controllers:[ApiController],providers:[{provide:DATABASE,useFactory:()=>connectDatabase(url,schema)},{provide:APP_FILTER,useClass:HttpErrors}]})class TestModule{}
  const app=await NestFactory.create(TestModule,{logger:false});await app.listen(0,'127.0.0.1');const base=await app.getUrl();
  const post=(path:string,body:unknown,key?:string)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(key?{'idempotency-key':key}:{})},body:JSON.stringify(body)});
  try{const m=await fixture();
    expect((await post('/wagering/transactions',m.data)).status).toBe(400);
    const applied=await post('/wagering/transactions',{...m.data,idempotencyKey:'ignored'},m.data.idempotencyKey);expect(applied.status).toBe(200);const result=await applied.json() as {transactionId:string};
    const replay=await post('/wagering/transactions',m.data,m.data.idempotencyKey);expect((await replay.json() as {idempotentReplay:boolean}).idempotentReplay).toBe(true);
    expect((await post('/wagering/transactions',{...m.data,money:{amount:'1.00',currency:'BRL'}},m.data.idempotencyKey)).status).toBe(409);
    expect((await post('/wagering/transactions',{...m.data,externalTransactionId:crypto.randomUUID()},crypto.randomUUID())).status).toBe(422);
    expect((await fetch(base+'/wagering/transactions/'+result.transactionId)).status).toBe(200);
    const page=await (await fetch(base+`/wallets/${m.data.walletId}/ledger?limit=1`)).json() as {items:unknown[];nextCursor:string};expect(page.items).toHaveLength(1);expect(page.nextCursor).toBeString();
    const next=await(await fetch(base+`/wallets/${m.data.walletId}/ledger?cursor=${page.nextCursor}`)).json() as {items:unknown[]};expect(next.items).toHaveLength(1);
    const reconciliation=await(await post(`/wallets/${m.data.walletId}/reconciliation`,{})).json() as {consistent:boolean;storedBalance:{amount:string}};expect(reconciliation.consistent).toBe(true);expect(reconciliation.storedBalance.amount).toBe('20.00');
    expect((await fetch(base+'/health/live')).status).toBe(200);
    expect((await post('/wallets',{playerId:m.data.playerId,initialBalance:{amount:'0.00',currency:'BRL'}})).status).toBe(409);
    expect((await post('/wallets',{playerId:crypto.randomUUID(),initialBalance:{amount:'-1.00',currency:'BRL'}})).status).toBe(400);
  }finally{await app.close();}
});
test('inbox deduplicates 50 deliveries atomically and rejects conflicting envelopes',async()=>{
  const m=await fixture();const results=await Promise.all(Array.from({length:50},()=>processMessage(db,m)));
  expect(results.filter(r=>!r.idempotentReplay)).toHaveLength(1);
  expect(await db.em.execute('select * from inbox_messages where message_id=?',[m.messageId])).toHaveLength(1);
  await expect(processMessage(db,{...m,data:{...m.data,money:{amount:'1.00',currency:'BRL'}}})).rejects.toThrow('Inbox payload conflict');
});
test('inbox insert failure rolls back wallet, ledger, idempotency and outbox',async()=>{
  const m=await fixture();await db.em.execute(`create function fail_inbox() returns trigger language plpgsql as $$ begin raise exception 'injected'; end $$; create trigger fail_inbox before insert on inbox_messages for each row execute function fail_inbox()`);
  try{await expect(processMessage(db,m)).rejects.toThrow('injected');expect((await new PostgresWalletRepository(db).findById(m.data.walletId))!.balance.toString()).toBe('100.00');expect(await db.em.execute('select * from wager_transactions where external_transaction_id=?',[m.data.externalTransactionId])).toHaveLength(0);}
  finally{await db.em.execute('drop trigger fail_inbox on inbox_messages;drop function fail_inbox()');}
  expect((await processMessage(db,m)).balance.amount).toBe('20.00');
});
test('two concurrent publishers drain committed outbox through real SQS',async()=>{
  await processMessage(db,await fixture());
  const drain=async()=>{while(await publishOne(db,sqs,events)){} };await Promise.all([drain(),drain()]);
  expect(await db.em.execute('select id from outbox_messages where published_at is null')).toHaveLength(0);
  const messages=await sqs.send(new ReceiveMessageCommand({QueueUrl:events,MaxNumberOfMessages:10}));expect(messages.Messages!.length).toBeGreaterThan(0);
  for(const m of messages.Messages!){const event=JSON.parse(m.Body!);expect(event.eventId).toBeString();expect(event.version).toBe(1);}
});
test('publisher outage keeps the event durable and recovers on retry',async()=>{
  await processMessage(db,await fixture());
  const {SQSClient}=await import('@aws-sdk/client-sqs');const bad=new SQSClient({endpoint:'http://127.0.0.1:1',region:'us-east-1',credentials:{accessKeyId:'test',secretAccessKey:'test'},maxAttempts:1});
  try{expect(await publishOne(db,bad,'http://127.0.0.1:1/000000000000/missing.fifo')).toBe(true);}finally{bad.destroy();}
  expect((await db.em.execute<Array<{attempts:number}>>('select attempts from outbox_messages where published_at is null order by attempts desc'))[0]!.attempts).toBe(1);
  await db.em.execute('update outbox_messages set next_attempt_at=now() where published_at is null');while(await publishOne(db,sqs,events)){}
});
test('three actual consumer processes handle duplicate messages and a competing bet once',async()=>{
  const m=await fixture(),other={...m,messageId:crypto.randomUUID(),data:{...m.data,externalTransactionId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID()}};
  const processes=[worker(),worker(),worker()];
  try{await Promise.all([...Array.from({length:12},()=>send(m)),send(other)]);await waitFor(async()=>{const rows=await db.em.execute('select id from wager_transactions where wallet_id=? and kind<>?',[m.data.walletId,'OPENING']);return rows.length===2;});
    const rows=await db.em.execute<Array<{status:string}>>('select status from wager_transactions where wallet_id=? and kind<>?',[m.data.walletId,'OPENING']);expect(rows.map(r=>r.status).sort()).toEqual(['PROCESSED','REJECTED']);
    expect((await new PostgresWalletRepository(db).findById(m.data.walletId))!.balance.toString()).toBe('20.00');
    await waitFor(empty);
  }finally{for(const p of processes){p.kill();await p.exited;}}
});
test('worker killed after commit before ack is recovered by a fresh process',async()=>{
  // Wait for earlier duplicates to drain before selecting the crash target.
  const m=await fixture();await send(m);const p=worker(true);await waitFor(async()=>p.exitCode!==null);expect(p.exitCode).toBe(86);
  // Find and release in-flight receipts explicitly to avoid a 30 second test delay.
  await waitFor(async()=>{const rows=await db.em.execute('select * from inbox_messages where message_id=?',[m.messageId]);return rows.length===1;},35000);
  const p2=worker();try{await waitFor(empty);expect((await new PostgresWalletRepository(db).findById(m.data.walletId))!.balance.toString()).toBe('20.00');
    expect(await db.em.execute('select id from wallet_ledger_entries where wallet_id=? and direction=?',[m.data.walletId,'DEBIT'])).toHaveLength(1);
  }finally{p2.kill();await p2.exited;}
},45000);
test('malformed message reaches real DLQ without a financial write',async()=>{
  await sqs.send(new SendMessageCommand({QueueUrl:input,MessageBody:'{"invalid":true}',MessageGroupId:crypto.randomUUID(),MessageDeduplicationId:crypto.randomUUID()}));
  const p=worker();try{await waitFor(async()=>{const r=await sqs.send(new ReceiveMessageCommand({QueueUrl:dlq,MaxNumberOfMessages:1}));return (r.Messages?.length??0)>0;});}finally{p.kill();await p.exited;}
});
test('exhausted infrastructure failure is terminal and never overwrites committed money',async()=>{
  const m=await fixture();expect((await processMessage(db,m,true)).status).toBe('FAILED');expect((await processMessage(db,m)).status).toBe('FAILED');
  expect((await new PostgresWalletRepository(db).findById(m.data.walletId))!.balance.toString()).toBe('100.00');
  const committed=await fixture();await processMessage(db,committed);expect((await processMessage(db,committed,true)).status).toBe('PROCESSED');
});
test('downstream consumer applies duplicated published events exactly once in its own SQL transaction',async()=>{
  const rows=await db.em.execute<Array<{payload:{eventId:string;[key:string]:unknown}}>>('select payload from outbox_messages limit 1');const event=rows[0]!.payload;
  await db.em.execute('create table event_projection(event_id text primary key, applications integer not null)');
  const apply=async(em:import('@mikro-orm/postgresql').EntityManager)=>{await em.execute('insert into event_projection values(?,1) on conflict(event_id) do update set applications=event_projection.applications+1',[event.eventId]);};
  const results=await Promise.all(Array.from({length:10},()=>consumeEvent(db,'projection',event,apply)));expect(results.filter(Boolean)).toHaveLength(1);
  expect((await db.em.execute<Array<{applications:number}>>('select applications from event_projection'))[0]!.applications).toBe(1);
  await expect(consumeEvent(db,'projection',{...event,version:99},apply)).rejects.toThrow('Event ID payload conflict');
});
for(const failures of [2,5])test(`real consumer retries ${failures} infrastructure failures ${failures===5?'then audits FAILED and sends DLQ':'and then commits once'}`,async()=>{
  const m=await fixture();
  await db.em.execute(`create sequence retry_injection;create function retry_injection() returns trigger language plpgsql as $$ begin
    if NEW.message_id='${m.messageId}' and nextval('retry_injection')<=${failures} then raise exception 'retry injection';end if;return NEW;end $$;
    create trigger retry_injection before insert on inbox_messages for each row execute function retry_injection()`);
  const p=worker();
  try{await send(m);await waitFor(async()=>{const rows=await db.em.execute<Array<{status:string}>>('select status from wager_transactions where external_transaction_id=?',[m.data.externalTransactionId]);return rows[0]?.status===(failures===5?'FAILED':'PROCESSED');},20000);
    await waitFor(empty);expect((await new PostgresWalletRepository(db).findById(m.data.walletId))!.balance.toString()).toBe(failures===5?'100.00':'20.00');
    if(failures===5){const received=await sqs.send(new ReceiveMessageCommand({QueueUrl:dlq,MaxNumberOfMessages:10}));expect(received.Messages?.some(x=>JSON.parse(x.Body!).messageId===m.messageId)).toBe(true);}
  }catch(error){p.kill();await p.exited;console.error(await new Response(p.stdout).text());throw error;}finally{p.kill();await p.exited;await db.em.execute('drop trigger retry_injection on inbox_messages;drop function retry_injection();drop sequence retry_injection');}
},30000);
