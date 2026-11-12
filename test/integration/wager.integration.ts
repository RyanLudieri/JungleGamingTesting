import { beforeAll, afterAll, expect, test } from 'bun:test';
import { connectDatabase } from '../../src/shared/infrastructure/database';
import type { Database } from '../../src/shared/infrastructure/database';
import { OpenWalletUseCase } from '../../src/wallet/application/open-wallet.use-case';
import { PostgresWalletRepository } from '../../src/wallet/infrastructure/postgres-wallet.repository';
import { Money } from '../../src/shared/domain/money';
import { ProcessWagerUseCase } from '../../src/wagering/application/process-wager.use-case';
import { PostgresWagerUnitOfWork } from '../../src/wagering/infrastructure/postgres-wager-unit-of-work';
import { IdempotencyConflictError } from '../../src/wagering/application/wager-command';
import type { WagerCommand } from '../../src/wagering/application/wager-command';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/wagering_test' || url === process.env.DATABASE_URL) throw new Error('Dedicated TEST_DATABASE_URL required');
const schema = `wager_test_${crypto.randomUUID().replaceAll('-','')}`;
let orm: Database; let admin: Database; let processWager: ProcessWagerUseCase; let repo: PostgresWalletRepository;
async function fixture(amount = '100.00'): Promise<WagerCommand> {
  const wallet = await new OpenWalletUseCase(repo).execute({playerId:crypto.randomUUID(),initialBalance:Money.from({amount,currency:'BRL'})});
  return {providerId:'provider',externalTransactionId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),
    playerId:wallet.playerId,walletId:wallet.id,roundId:'round',gameId:'game',kind:'BET',money:{amount:'80.00',currency:'BRL'}};
}
const different = (c: WagerCommand, changes: Partial<WagerCommand> = {}): WagerCommand => ({...c,
  externalTransactionId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),...changes});
async function count(table: string, walletId: string): Promise<number> {
  const column = table==='outbox_messages'?'aggregate_id':'wallet_id';
  const rows = await orm.em.execute<{n:number}[]>(`select count(*)::int as n from ${table} where ${column}=?`,[walletId]);
  return rows[0]!.n;
}
async function reconcile(): Promise<void> {
  const rows = await orm.em.execute<{id:string}[]>(`select w.id from wallets w left join wallet_ledger_entries e on e.wallet_id=w.id
    group by w.id having w.balance<>coalesce(sum(case when e.direction='CREDIT' then e.amount else -e.amount end),0)`);
  expect(rows).toEqual([]);
}
beforeAll(async () => {
  admin = await connectDatabase(url);
  await admin.em.execute(`create schema ${schema}`);
  orm = await connectDatabase(url,schema);
  await orm.migrator.up();
  const preserved = await new OpenWalletUseCase(new PostgresWalletRepository(orm)).execute({
    playerId:crypto.randomUUID(),initialBalance:Money.from({amount:'123.45',currency:'BRL'}) });
  await orm.migrator.down();
  await orm.migrator.up();
  repo = new PostgresWalletRepository(orm);
  expect((await repo.findById(preserved.id))?.balance.toString()).toBe('123.45');
  expect(await repo.findLedger(preserved.id)).toHaveLength(1);
  processWager = new ProcessWagerUseCase(new PostgresWagerUnitOfWork(orm));
});
afterAll(async () => {
  try { if (orm) { await reconcile(); await orm.close(true); } }
  finally { if (admin) { await admin.em.execute(`drop schema ${schema} cascade`); await admin.close(true); } }
});

test('two simultaneous bets of 80 against 100 produce one debit and an auditable rejection', async () => {
  const c = await fixture();
  const results = await Promise.all([processWager.execute(c),processWager.execute(different(c))]);
  expect(results.filter(r=>r.status==='PROCESSED')).toHaveLength(1);
  expect(results.find(r=>r.status==='REJECTED')?.failureCode).toBe('INSUFFICIENT_BALANCE');
  expect((await repo.findById(c.walletId))?.balance.toString()).toBe('20.00');
  expect(await count('wallet_ledger_entries',c.walletId)).toBe(2);
  expect(await count('outbox_messages',c.walletId)).toBe(3);
});

test('50 parallel identical requests debit once; new keys also replay the original operation', async () => {
  const c = await fixture();
  const results = await Promise.all(Array.from({length:50},()=>processWager.execute(c)));
  expect(new Set(results.map(r=>r.transactionId)).size).toBe(1);
  expect(results.filter(r=>!r.idempotentReplay)).toHaveLength(1);
  const alias = {...c,idempotencyKey:'alias-'+crypto.randomUUID()};
  expect((await processWager.execute(alias)).idempotentReplay).toBe(true);
  await expect(processWager.execute({...alias,money:{amount:'1.00',currency:'BRL'}})).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect(await count('wallet_ledger_entries',c.walletId)).toBe(2);
  expect(await count('outbox_messages',c.walletId)).toBe(2);
});

test('conflicting key or external identity cannot create another financial effect', async () => {
  const c = await fixture(); await processWager.execute(c);
  await expect(processWager.execute({...c,money:{amount:'1.00',currency:'BRL'}})).rejects.toBeInstanceOf(IdempotencyConflictError);
  await expect(processWager.execute({...c,idempotencyKey:crypto.randomUUID(),roundId:'different'})).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect((await repo.findById(c.walletId))?.balance.toString()).toBe('20.00');
});

test('WIN credits and LOSS leaves balance/version intact; replay retains original observed balance', async () => {
  const c = await fixture(); const bet = await processWager.execute(c);
  const win = await processWager.execute(different(c,{kind:'WIN',money:{amount:'30.00',currency:'BRL'},referenceExternalTransactionId:c.externalTransactionId}));
  expect(win.balance.amount).toBe('50.00');
  const loss = await processWager.execute(different(c,{kind:'LOSS',money:{amount:'0.00',currency:'BRL'}}));
  expect(loss.status).toBe('PROCESSED');
  expect((await repo.findById(c.walletId))?.version).toBe(3);
  expect(await count('wallet_ledger_entries',c.walletId)).toBe(3);
  expect(await count('outbox_messages',c.walletId)).toBe(5);
  expect(await processWager.execute(c)).toEqual({...bet,idempotentReplay:true});
});

test('business rejections preserve balance and create only rejection events', async () => {
  const c = await fixture();
  for (const [change,code] of [[{playerId:crypto.randomUUID()},'PLAYER_MISMATCH'],
    [{money:{amount:'1.00',currency:'USD'}},'CURRENCY_MISMATCH']] as const) {
    const result = await processWager.execute(different(c,change));
    expect(result.failureCode).toBe(code);
  }
  expect((await repo.findById(c.walletId))?.balance.toString()).toBe('100.00');
  expect(await count('wallet_ledger_entries',c.walletId)).toBe(1);
  expect(await count('outbox_messages',c.walletId)).toBe(2);
});

test('missing WIN reference is persisted without financial effects', async () => {
  const c = await fixture();
  expect((await processWager.execute({...c,kind:'WIN',referenceExternalTransactionId:'missing'})).status).toBe('PENDING_REFERENCE');
  expect(await count('wager_transactions',c.walletId)).toBe(2);
  expect(await count('wallet_ledger_entries',c.walletId)).toBe(1);
});

test('outbox insertion failure rolls back wallet, ledger, transaction and idempotency; retry succeeds', async () => {
  const c = await fixture();
  await orm.em.execute(`create function fail_test_outbox() returns trigger language plpgsql as $$ begin
    if NEW.aggregate_id='${c.walletId}'::uuid then raise exception 'Injected outbox failure'; end if; return NEW; end $$;
    create trigger fail_test_outbox before insert on outbox_messages for each row execute function fail_test_outbox()`);
  try { await expect(processWager.execute(c)).rejects.toThrow('Injected outbox failure'); }
  finally { await orm.em.execute('drop trigger fail_test_outbox on outbox_messages; drop function fail_test_outbox()'); }
  expect((await repo.findById(c.walletId))?.balance.toString()).toBe('100.00');
  expect(await count('wager_transactions',c.walletId)).toBe(1);
  expect(await count('wallet_ledger_entries',c.walletId)).toBe(1);
  expect(await count('outbox_messages',c.walletId)).toBe(0);
  const keys = await orm.em.execute<unknown[]>('select * from wager_idempotency where provider_id=? and idempotency_key=?',[c.providerId,c.idempotencyKey]);
  expect(keys).toHaveLength(0);
  expect((await processWager.execute(c)).status).toBe('PROCESSED');
});

test('wallets progress independently while another wallet is locked', async () => {
  const a = await fixture(); const b = await fixture();
  let unlock!: ()=>void; let locked!: ()=>void;
  const held = new Promise<void>(resolve=>{unlock=resolve});
  const acquired = new Promise<void>(resolve=>{locked=resolve});
  const blocker = orm.em.fork().transactional(async em=>{
    await em.execute('select id from wallets where id=? for update',[a.walletId]); locked(); await held;
  });
  await acquired;
  const pending = processWager.execute(a);
  try {
    const independent = await Promise.race([processWager.execute(b),Bun.sleep(3000).then(()=>{throw new Error('Independent wallet blocked')})]);
    expect(independent.status).toBe('PROCESSED');
  } finally { unlock(); await blocker; await pending; }
});

test('fresh ORM instance replays persisted result and event envelopes remain stable', async () => {
  const c = await fixture(); const original = await processWager.execute(c,{correlationId:'correlation',causationId:'request'});
  const fresh = await connectDatabase(url,schema);
  try {
    expect(await new ProcessWagerUseCase(new PostgresWagerUnitOfWork(fresh)).execute(c)).toEqual({...original,idempotentReplay:true});
  } finally {await fresh.close(true)}
  const events = await orm.em.execute<{payload:{eventId:string;version:number;correlationId:string;causationId:string}}[]>(
    'select payload from outbox_messages where transaction_id=?',[original.transactionId]);
  expect(events).toHaveLength(2);
  for(const e of events){expect(e.payload.version).toBe(1);expect(e.payload.correlationId).toBe('correlation');expect(e.payload.causationId).toBe('request');expect(e.payload.eventId).toBeString()}
  await reconcile();
});

test('parallel different keys for one external identity still produce one debit', async () => {
  const c = await fixture();
  const results = await Promise.all(Array.from({length:12},()=>processWager.execute({...c,idempotencyKey:crypto.randomUUID()})));
  expect(new Set(results.map(r=>r.transactionId)).size).toBe(1);
  expect(results.filter(r=>!r.idempotentReplay)).toHaveLength(1);
  expect(await count('wallet_ledger_entries',c.walletId)).toBe(2);
  expect(await count('outbox_messages',c.walletId)).toBe(2);
});

test('rejected bet remains rejected on replay after a later credit', async () => {
  const c = await fixture('0.00');
  const rejected = await processWager.execute(c);
  expect(rejected.failureCode).toBe('INSUFFICIENT_BALANCE');
  await processWager.execute(different(c,{kind:'WIN',money:{amount:'100.00',currency:'BRL'}}));
  expect(await processWager.execute(c)).toEqual({...rejected,idempotentReplay:true});
  expect((await repo.findById(c.walletId))?.balance.toString()).toBe('100.00');
  expect((await repo.findById(c.walletId))?.version).toBe(2);
  expect(await count('wallet_ledger_entries',c.walletId)).toBe(1);
});

test('WIN overflow and incompatible reference are audited without credits', async () => {
  const full = await fixture('9999999999999999.99');
  const overflow = await processWager.execute({...full,kind:'WIN',money:{amount:'0.01',currency:'BRL'}});
  expect(overflow.failureCode).toBe('MONEY_OUT_OF_RANGE');
  expect(await count('wallet_ledger_entries',full.walletId)).toBe(1);
  const c = await fixture(); await processWager.execute(c);
  const result = await processWager.execute(different(c,{kind:'WIN',roundId:'wrong-round',referenceExternalTransactionId:c.externalTransactionId}));
  expect(result.failureCode).toBe('INVALID_REFERENCE');
  expect((await repo.findById(c.walletId))?.balance.toString()).toBe('20.00');
});

test('migration rollback refuses to discard committed wagers', async () => {
  const c = await fixture(); const result = await processWager.execute(c);
  await expect(orm.migrator.down({to:'Migration202611100001'})).rejects.toThrow('Cannot revert');
  expect(await processWager.execute(c)).toEqual({...result,idempotentReplay:true});
  expect(await count('outbox_messages',c.walletId)).toBe(2);
});
