import { expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/wallet/domain/wallet';
import { LedgerDirection } from '../../src/wallet/domain/wallet-ledger-entry';

const money = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });
const at = new Date('2026-01-01T00:00:00Z');
const context = { entryId: 'entry-1', transactionId: 'tx-1', at: new Date('2026-01-02T00:00:00Z') };
const open = (amount = '100.00'): Wallet => Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money(amount), at });

test('opens with version 1, including a zero balance', () => {
  expect(open().version).toBe(1);
  expect(open('0.00').balance.isZero()).toBe(true);
  expect(() => open('-0.01')).toThrow();
  expect(() => Wallet.open({ id: '', playerId: 'p', initialBalance: money('0.00'), at })).toThrow();
});

test('debit and credit return matching ledger entries and increment version', () => {
  const wallet = open();
  const debit = wallet.debit(money('80.00'), context);
  expect(wallet.balance.toString()).toBe('20.00');
  expect(wallet.version).toBe(2);
  expect(wallet.updatedAt).toEqual(context.at);
  expect(debit.direction).toBe(LedgerDirection.Debit);
  expect(debit.balanceBefore.toString()).toBe('100.00');
  expect(debit.balanceAfter.equals(wallet.balance)).toBe(true);
  const credit = wallet.credit(money('5.00'), { ...context, entryId: 'entry-2', transactionId: 'tx-2' });
  expect(wallet.balance.toString()).toBe('25.00');
  expect(wallet.version).toBe(3);
  expect(credit.direction).toBe(LedgerDirection.Credit);
  expect(credit.walletId).toBe(wallet.id);
  expect(credit.isBalanced()).toBe(true);
  expect(debit.balanceAfter.toString()).toBe('20.00');
});

test('allows debit of the entire balance', () => {
  const wallet = open();
  wallet.debit(money('100.00'), context);
  expect(wallet.balance.isZero()).toBe(true);
});

test('every rejected movement preserves balance, version and timestamp', () => {
  const wallet = open();
  const operations = [
    () => wallet.debit(money('100.01'), context),
    () => wallet.debit(money('1.00', 'USD'), context),
    () => wallet.credit(money('1.00', 'EUR'), context),
    () => wallet.debit(money('0.00'), context),
    () => wallet.credit(money('0.00'), context),
    () => wallet.debit(money('-1.00'), context),
    () => wallet.credit(money('-1.00'), context),
    () => wallet.credit(money('9999999999999999.99'), context),
    () => wallet.debit(money('1.00'), { ...context, entryId: '' }),
    () => wallet.credit(money('1.00'), { ...context, at: new Date('invalid') }),
  ];
  for (const operation of operations) {
    expect(operation).toThrow();
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(at);
  }
  expect(operations[0]).toThrow(expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }));
});

test('rehydrates without resetting version or applying an opening operation', () => {
  const wallet = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: money('20.00'),
    version: 7, createdAt: at, updatedAt: context.at });
  expect(wallet.version).toBe(7);
  wallet.credit(money('1.00'), context);
  expect(wallet.version).toBe(8);
  expect(wallet.balance.toString()).toBe('21.00');
});

test('protects identity, balance and dates from external mutation', () => {
  const date = new Date(at);
  const wallet = Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('1.00'), at: date });
  date.setFullYear(2000);
  wallet.createdAt.setFullYear(2001);
  wallet.updatedAt.setFullYear(2002);
  expect(wallet.createdAt).toEqual(at);
  expect(wallet.updatedAt).toEqual(at);
  expect(Reflect.set(wallet, 'balance', money('999.00'))).toBe(false);
  expect(Reflect.set(wallet, 'id', 'other')).toBe(false);
  expect(wallet.balance.toString()).toBe('1.00');
});
