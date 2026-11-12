import { expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { LedgerDirection, WalletLedgerEntry } from '../../src/wallet/domain/wallet-ledger-entry';
import type { LedgerEntryState } from '../../src/wallet/domain/wallet-ledger-entry';

const money = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });
const state = (): LedgerEntryState => ({ id: 'entry', walletId: 'wallet', transactionId: 'tx',
  direction: LedgerDirection.Debit, money: money('80.00'), balanceBefore: money('100.00'),
  balanceAfter: money('20.00'), createdAt: new Date('2026-01-01T00:00:00Z') });

test('validates debit and credit arithmetic', () => {
  expect(WalletLedgerEntry.create(state()).isBalanced()).toBe(true);
  expect(WalletLedgerEntry.create({ ...state(), direction: LedgerDirection.Credit,
    balanceAfter: money('180.00') }).isBalanced()).toBe(true);
});

test('rejects inconsistent balances, currencies, direction, identifiers and amounts', () => {
  const overrides: Partial<LedgerEntryState>[] = [
    { balanceAfter: money('21.00') }, { balanceAfter: money('-1.00') },
    { balanceBefore: money('-1.00') }, { money: money('0.00') }, { money: money('-80.00') },
    { money: money('80.00', 'USD') }, { balanceAfter: money('20.00', 'EUR') },
    { id: '' }, { walletId: ' ' }, { transactionId: '' }, { createdAt: new Date('invalid') },
    { direction: 'OTHER' as LedgerDirection },
  ];
  for (const override of overrides) {
    expect(() => WalletLedgerEntry.create({ ...state(), ...override })).toThrow();
  }
});

test('is immutable including dates received and returned', () => {
  const input = state();
  const entry = WalletLedgerEntry.create(input);
  input.createdAt.setFullYear(2000);
  entry.createdAt.setFullYear(2001);
  expect(entry.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  expect(Reflect.set(entry, 'money', money('1.00'))).toBe(false);
  expect(Reflect.set(entry.money, 'currency', 'USD')).toBe(false);
  expect(entry.isBalanced()).toBe(true);
});

test('rehydrates persisted data without applying a movement', () => {
  const entry = WalletLedgerEntry.rehydrate(state());
  expect(entry.transactionId).toBe('tx');
  expect(entry.balanceAfter.toString()).toBe('20.00');
  expect(entry.isBalanced()).toBe(true);
});
