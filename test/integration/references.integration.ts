import { beforeAll, afterAll, expect, test } from 'bun:test';
import { connectDatabase } from '../../src/shared/infrastructure/database';
import type { Database } from '../../src/shared/infrastructure/database';
import { OpenWalletUseCase } from '../../src/wallet/application/open-wallet.use-case';
import { PostgresWalletRepository } from '../../src/wallet/infrastructure/postgres-wallet.repository';
import { Money } from '../../src/shared/domain/money';
import { ProcessWagerUseCase } from '../../src/wagering/application/process-wager.use-case';
import { PostgresWagerUnitOfWork } from '../../src/wagering/infrastructure/postgres-wager-unit-of-work';
import type { WagerCommand } from '../../src/wagering/application/wager-command';
import type { WagerResult } from '../../src/wagering/application/wager-unit-of-work';

const url=process.env.TEST_DATABASE_URL;
if(!url || new URL(url).pathname!=='/wagering_test' || url===process.env.DATABASE_URL)throw new Error('Dedicated test database required');
const schema=`reference_test_${crypto.randomUUID().replaceAll('-','')}`;
let admin:Database;let orm:Database;let repo:PostgresWalletRepository;let useCase:ProcessWagerUseCase;
let time=new Date('2030-01-01T00:00:00Z');
const policy={ttlMs:900000,initialBackoffMs:1000,maxBackoffMs:60000};
const next=(c:WagerCommand,change:Partial<WagerCommand>={}):WagerCommand=>({...c,externalTransactionId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),...change});
async function fixture():Promise<WagerCommand>{
  const w=await new OpenWalletUseCase(repo).execute({playerId:crypto.randomUUID(),initialBalance:Money.from({amount:'100.00',currency:'BRL'})});
  return {providerId:'p',externalTransactionId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),walletId:w.id,playerId:w.playerId,
    roundId:'r',gameId:'g',kind:'BET',money:{amount:'20.00',currency:'BRL'}};
}
async function state(id:string){
  const rows=await orm.em.execute<Array<{status:string;result:WagerResult;current_result:WagerResult;reference_attempts:number;next_attempt_at:string}>>(
    'select status,result,current_result,reference_attempts,next_attempt_at from wager_transactions where id=?',[id]);
  return rows[0]!;
}
beforeAll(async()=>{
  admin=await connectDatabase(url);await admin.em.execute(`create schema ${schema}`);
  orm=await connectDatabase(url,schema);await orm.migrator.up();
  repo=new PostgresWalletRepository(orm);useCase=new ProcessWagerUseCase(new PostgresWagerUnitOfWork(orm),policy,()=>time);
});
afterAll(async()=>{
  try{if(orm){
    const mismatches=await orm.em.execute<unknown[]>(`select w.id from wallets w left join wallet_ledger_entries e on e.wallet_id=w.id
      group by w.id having w.balance<>coalesce(sum(case when e.direction='CREDIT' then e.amount else -e.amount end),0)`);
    expect(mismatches).toHaveLength(0);await orm.close(true);
  }}finally{if(admin){await admin.em.execute(`drop schema ${schema} cascade`);await admin.close(true)}}
});

test('migration down/up preserves processed WIN references from the previous schema',async()=>{
  const c=await fixture();await useCase.execute(c);
  const win=next(c,{kind:'WIN',referenceExternalTransactionId:c.externalTransactionId});await useCase.execute(win);
  await orm.migrator.down({to:'Migration202611100002'});await orm.migrator.up();
  expect((await useCase.execute(next(c))).status).toBe('PROCESSED');
});

test('REFUND and ROLLBACK create compensations and enforce uniqueness per reversal kind',async()=>{
  const bet=await fixture();await useCase.execute(bet);
  const refund=next(bet,{kind:'REFUND',referenceExternalTransactionId:bet.externalTransactionId});
  const results=await Promise.all(Array.from({length:8},()=>useCase.execute(next(refund))));
  expect(results.filter(r=>r.status==='PROCESSED')).toHaveLength(1);
  expect(results.filter(r=>r.failureCode==='ALREADY_REVERSED')).toHaveLength(7);
  const rolled=await useCase.execute(next(bet,{kind:'ROLLBACK',referenceExternalTransactionId:bet.externalTransactionId}));
  expect(rolled.balance.amount).toBe('120.00'); // Specification: uniqueness is per kind.
  const repeat=await useCase.execute(next(bet,{kind:'ROLLBACK',referenceExternalTransactionId:bet.externalTransactionId}));
  expect(repeat.failureCode).toBe('ALREADY_REVERSED');
});

test('ROLLBACK of WIN and REFUND debits, and insufficient reversal balance has its own code',async()=>{
  const c=await fixture();const win=next(c,{kind:'WIN'});await useCase.execute(win);
  expect((await useCase.execute(next(c,{kind:'ROLLBACK',referenceExternalTransactionId:win.externalTransactionId}))).balance.amount).toBe('100.00');
  await useCase.execute(c);const refund=next(c,{kind:'REFUND',referenceExternalTransactionId:c.externalTransactionId});await useCase.execute(refund);
  expect((await useCase.execute(next(c,{kind:'ROLLBACK',referenceExternalTransactionId:refund.externalTransactionId}))).balance.amount).toBe('80.00');
  const win2=next(c,{kind:'WIN'});await useCase.execute(win2);
  await useCase.execute(next(c,{money:{amount:'100.00',currency:'BRL'}}));
  const failed=await useCase.execute(next(c,{kind:'ROLLBACK',referenceExternalTransactionId:win2.externalTransactionId}));
  expect(failed.failureCode).toBe('REVERSAL_INSUFFICIENT_BALANCE');expect(failed.balance.amount).toBe('0.00');
});

test('invalid references and partial reversal are rejected without compensation',async()=>{
  const c=await fixture();await useCase.execute(c);
  for(const change of [{money:{amount:'10.00',currency:'BRL'}},{roundId:'other'}]){
    expect((await useCase.execute(next(c,{kind:'REFUND',referenceExternalTransactionId:c.externalTransactionId,...change}))).failureCode).toBe('INVALID_REFERENCE');
  }
  const win=next(c,{kind:'WIN'});await useCase.execute(win);
  expect((await useCase.execute(next(c,{kind:'REFUND',referenceExternalTransactionId:win.externalTransactionId}))).failureCode).toBe('INVALID_REFERENCE');
  const failed=next(c,{money:{amount:'999.00',currency:'BRL'}});await useCase.execute(failed);
  expect((await useCase.execute(next(failed,{kind:'REFUND',referenceExternalTransactionId:failed.externalTransactionId}))).failureCode).toBe('INVALID_REFERENCE');
});

test.each(['REFUND','ROLLBACK','WIN'] as const)('%s before BET is processed later, while replay keeps the original acceptance',async(kind)=>{
  const c=await fixture();const dependent=next(c,{kind,referenceExternalTransactionId:c.externalTransactionId});
  const accepted=await useCase.execute(dependent);
  expect(accepted.status).toBe('PENDING_REFERENCE');expect(accepted.balance.amount).toBe('100.00');
  expect(await useCase.retryOne()).toBe(false);
  await useCase.execute(c);time=new Date(time.getTime()+1000);
  expect(await useCase.retryOne()).toBe(true);
  expect((await state(accepted.transactionId)).status).toBe('PROCESSED');
  expect((await repo.findById(c.walletId))?.balance.toString()).toBe('100.00');
  expect(await useCase.execute(dependent)).toEqual({...accepted,idempotentReplay:true});
  expect((await state(accepted.transactionId)).current_result.status).toBe('PROCESSED');
});

test('backoff is persistent and TTL expires once with rejection event',async()=>{
  const c=await fixture();const pending=await useCase.execute(next(c,{kind:'REFUND',referenceExternalTransactionId:'never-arrives'}));
  time=new Date(time.getTime()+1000);expect(await useCase.retryOne()).toBe(true);
  const scheduled=await state(pending.transactionId);
  expect(scheduled.reference_attempts).toBe(1);expect(new Date(scheduled.next_attempt_at).getTime()-time.getTime()).toBe(2000);
  expect(await useCase.retryOne()).toBe(false);
  time=new Date(time.getTime()+900000);expect(await useCase.retryOne()).toBe(true);
  expect((await state(pending.transactionId)).current_result.failureCode).toBe('REFERENCE_NOT_FOUND');
  expect(await useCase.retryOne()).toBe(false);
  const events=await orm.em.execute<{event_type:string}[]>('select event_type from outbox_messages where transaction_id=? order by event_type',[pending.transactionId]);
  expect(events.map(e=>e.event_type)).toEqual(['WagerTransactionPendingReference','WagerTransactionRejected']);
});

test('pending identity and original response cannot be edited in SQL',async()=>{
  const c=await fixture();const pending=await useCase.execute(next(c,{kind:'REFUND',referenceExternalTransactionId:c.externalTransactionId}));
  for(const sql of ["update wager_transactions set amount=1 where id=?","update wager_transactions set result='{}'::jsonb where id=?"]){
    await expect(orm.em.execute(sql,[pending.transactionId])).rejects.toThrow('immutable');
  }
  await useCase.execute(c);time=new Date(time.getTime()+1000);await useCase.retryOne();
  await expect(orm.em.execute("update wager_transactions set status='PENDING_REFERENCE' where id=?",[pending.transactionId])).rejects.toThrow('immutable');
});

test('concurrent workers in independent ORM instances complete one pending reversal once',async()=>{
  const c=await fixture();const pending=await useCase.execute(next(c,{kind:'REFUND',referenceExternalTransactionId:c.externalTransactionId}));
  await useCase.execute(c);time=new Date(time.getTime()+1000);
  const other=await connectDatabase(url,schema);
  try{
    const second=new ProcessWagerUseCase(new PostgresWagerUnitOfWork(other),policy,()=>time);
    const results=await Promise.all([useCase.retryOne(),second.retryOne()]);
    expect(results.filter(Boolean)).toHaveLength(1);
  }finally{await other.close(true)}
  expect((await state(pending.transactionId)).status).toBe('PROCESSED');
  expect(await repo.findLedger(c.walletId)).toHaveLength(3);
});

test('worker failure after changing state rolls back everything and a fresh worker recovers',async()=>{
  const c=await fixture();const pending=await useCase.execute(next(c,{kind:'REFUND',referenceExternalTransactionId:c.externalTransactionId}));
  await useCase.execute(c);time=new Date(time.getTime()+1000);
  await orm.em.execute(`create function fail_reference_event() returns trigger language plpgsql as $$ begin
    if NEW.transaction_id='${pending.transactionId}'::uuid then raise exception 'Injected reference failure'; end if; return NEW; end $$;
    create trigger fail_reference_event before insert on outbox_messages for each row execute function fail_reference_event()`);
  try{await expect(useCase.retryOne()).rejects.toThrow('Injected reference failure')}
  finally{await orm.em.execute('drop trigger fail_reference_event on outbox_messages; drop function fail_reference_event()')}
  expect((await state(pending.transactionId)).status).toBe('PENDING_REFERENCE');
  expect((await repo.findById(c.walletId))?.balance.toString()).toBe('80.00');
  const fresh=await connectDatabase(url,schema);
  try{expect(await new ProcessWagerUseCase(new PostgresWagerUnitOfWork(fresh),policy,()=>time).retryOne()).toBe(true)}finally{await fresh.close(true)}
  expect((await state(pending.transactionId)).status).toBe('PROCESSED');
});

test('two real worker processes consume a due reference through the CLI entrypoint',async()=>{
  const c=await fixture();
  const live=new ProcessWagerUseCase(new PostgresWagerUnitOfWork(orm),{...policy,initialBackoffMs:1});
  const pending=await live.execute(next(c,{kind:'REFUND',referenceExternalTransactionId:c.externalTransactionId}));
  await live.execute(c);
  const children=Array.from({length:2},()=>Bun.spawn([process.execPath,'src/wagering/infrastructure/reference-worker.ts'],{
    env:{...process.env,DATABASE_URL:url!,DATABASE_SCHEMA:schema,REFERENCE_POLL_MS:'50'},stdout:'ignore',stderr:'pipe'}));
  try{
    const deadline=Date.now()+10000;
    while((await state(pending.transactionId)).status==='PENDING_REFERENCE' && Date.now()<deadline)await Bun.sleep(50);
    expect((await state(pending.transactionId)).status).toBe('PROCESSED');
    expect(await repo.findLedger(c.walletId)).toHaveLength(3);
  }finally{
    for(const child of children)child.kill();
    await Promise.all(children.map(child=>child.exited));
  }
});
