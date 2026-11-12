import { afterAll, beforeAll, expect, test } from 'bun:test';
import { ForeignKeyConstraintViolationException } from '@mikro-orm/core';
import { connectDatabase } from '../../src/shared/infrastructure/database';
import type { Database } from '../../src/shared/infrastructure/database';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/wallet/domain/wallet';
import { WalletLedgerEntry, LedgerDirection } from '../../src/wallet/domain/wallet-ledger-entry';
import { OpenWalletUseCase, WalletAlreadyExistsError } from '../../src/wallet/application/open-wallet.use-case';
import { PostgresWalletRepository } from '../../src/wallet/infrastructure/postgres-wallet.repository';
import { OpeningTransactionEntity, WalletEntity, WalletLedgerEntryEntity } from '../../src/wallet/infrastructure/entities';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/wagering_test' || url === process.env.DATABASE_URL) {
  throw new Error('Set TEST_DATABASE_URL to the dedicated wagering_test database (never the development database)');
}
let orm: Database;
let repository: PostgresWalletRepository;
let useCase: OpenWalletUseCase;
const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
const player = () => crypto.randomUUID();

beforeAll(async () => {
  orm = await connectDatabase(url);
  await orm.migrator.up();
  // This suite owns the dedicated test database; rollback is deliberately tested.
  await orm.migrator.down({ to: 0 });
  const missing = await orm.em.getConnection().execute<{ name: string | null }[]>(
    "select to_regclass('wallets')::text as name");
  expect(missing[0]?.name).toBeNull();
  await orm.migrator.up();
  repository = new PostgresWalletRepository(orm);
  useCase = new OpenWalletUseCase(repository);
});

afterAll(async () => { if (orm) await orm.close(true); });

test('zero opening persists version 1 without transaction or ledger', async () => {
  const wallet = await useCase.execute({ playerId: player(), initialBalance: money('0.00') });
  expect((await repository.findById(wallet.id))?.version).toBe(1);
  expect(await repository.findLedger(wallet.id)).toEqual([]);
  expect(await orm.em.fork().count(OpeningTransactionEntity, { walletId: wallet.id })).toBe(0);
});

test('positive opening reconciles and rehydrates exact money, even above floating point precision', async () => {
  for (const amount of ['100.00', '9007199254740993.01']) {
    const wallet = await useCase.execute({ playerId: player(), initialBalance: money(amount) });
    const stored = await repository.findById(wallet.id);
    const entries = await repository.findLedger(wallet.id);
    expect(stored?.balance.toString()).toBe(amount);
    expect(stored?.version).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.balanceBefore.toString()).toBe('0.00');
    expect(entries[0]?.money.equals(stored!.balance)).toBe(true);
    expect(entries[0]?.isBalanced()).toBe(true);
    const tx = await orm.em.fork().findOneOrFail(OpeningTransactionEntity, { walletId: wallet.id });
    expect(tx.kind).toBe('OPENING');
    expect(tx.status).toBe('PROCESSED');
  }
});

test('concurrent openings for same player and currency have one winner', async () => {
  const playerId = player();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
    useCase.execute({ playerId, initialBalance: money('100.00') })));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  for (const result of results) {
    if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(WalletAlreadyExistsError);
  }
  expect(await orm.em.fork().count(WalletEntity, { playerId })).toBe(1);
  const wallet = await orm.em.fork().findOneOrFail(WalletEntity, { playerId });
  expect(await orm.em.fork().count(WalletLedgerEntryEntity, { walletId: wallet.id })).toBe(1);
});

test('different currencies for same player can coexist', async () => {
  const playerId = player();
  await Promise.all(['BRL', 'USD'].map(currency => useCase.execute({ playerId, initialBalance: money('1.00', currency) })));
  expect(await orm.em.fork().count(WalletEntity, { playerId })).toBe(2);
});

test('failure after wallet and transaction flush rolls back every write', async () => {
  const id = crypto.randomUUID();
  const wallet = Wallet.open({ id, playerId: player(), initialBalance: money('100.00'), at: new Date() });
  const entry = WalletLedgerEntry.create({ id: crypto.randomUUID(), walletId: crypto.randomUUID(),
    transactionId: crypto.randomUUID(), money: money('100.00'), direction: LedgerDirection.Credit,
    balanceBefore: money('0.00'), balanceAfter: money('100.00'), createdAt: new Date() });
  await expect(repository.saveOpening(wallet, entry)).rejects.toThrow();
  expect(await repository.findById(id)).toBeNull();
  expect(await orm.em.fork().count(OpeningTransactionEntity, { walletId: id })).toBe(0);
  expect(await orm.em.fork().count(WalletLedgerEntryEntity, { transactionId: entry.transactionId })).toBe(0);
});

test('deferred check rejects missing opening ledger at commit', async () => {
  const wallet = Wallet.open({ id: crypto.randomUUID(), playerId: player(), initialBalance: money('100.00'), at: new Date() });
  await expect(repository.saveOpening(wallet, undefined)).rejects.toThrow();
  expect(await repository.findById(wallet.id)).toBeNull();
});

test('database rejects negative balances, inconsistent balance/version and NaN', async () => {
  const wallet = await useCase.execute({ playerId: player(), initialBalance: money('100.00') });
  for (const statement of [
    "update wallets set balance = -1 where id = ?",
    "update wallets set balance = 'NaN' where id = ?",
    'update wallets set balance = 99 where id = ?',
    'update wallets set version = 2 where id = ?',
  ]) await expect(orm.em.getConnection().execute(statement, [wallet.id])).rejects.toThrow();
  expect((await repository.findById(wallet.id))?.balance.toString()).toBe('100.00');
});

test('database rejects edits/deletes/truncation of ledger and terminal opening transaction', async () => {
  const wallet = await useCase.execute({ playerId: player(), initialBalance: money('100.00') });
  for (const table of ['wallet_ledger_entries', 'wager_transactions']) {
    await expect(orm.em.getConnection().execute(`update ${table} set amount=amount where wallet_id=?`, [wallet.id])).rejects.toThrow();
    await expect(orm.em.getConnection().execute(`delete from ${table} where wallet_id=?`, [wallet.id])).rejects.toThrow();
  }
  await expect(orm.em.getConnection().execute('truncate wallet_ledger_entries')).rejects.toThrow();
  expect(await repository.findLedger(wallet.id)).toHaveLength(1);
});

test('database rejects duplicate ledger and invalid financial references', async () => {
  const wallet = await useCase.execute({ playerId: player(), initialBalance: money('100.00') });
  const original = await orm.em.fork().findOneOrFail(WalletLedgerEntryEntity, { walletId: wallet.id });
  for (const changes of [{}, { transactionId: crypto.randomUUID() }, { currency: 'USD' }, { amount: '99.00' }]) {
    const em = orm.em.fork();
    em.persist(em.create(WalletLedgerEntryEntity, { ...original, id: crypto.randomUUID(), ...changes }));
    await expect(em.flush()).rejects.toThrow();
  }
  expect(await repository.findLedger(wallet.id)).toHaveLength(1);
  const em = orm.em.fork();
  em.persist(em.create(WalletLedgerEntryEntity, { ...original, id: crypto.randomUUID(),
    transactionId: crypto.randomUUID(), walletVersion: 2 }));
  await expect(em.flush()).rejects.toBeInstanceOf(ForeignKeyConstraintViolationException);
});

test('new ORM instance recovers committed wallet and ledger', async () => {
  const wallet = await useCase.execute({ playerId: player(), initialBalance: money('123.45') });
  const other = await connectDatabase(url);
  try {
    const fresh = new PostgresWalletRepository(other);
    const stored = await fresh.findById(wallet.id);
    const entries = await fresh.findLedger(wallet.id);
    expect(stored?.balance.equals(entries[0]!.money)).toBe(true);
  } finally { await other.close(true); }
});
