import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { DomainError } from '../../src/shared/domain/domain-error';

const money = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });

describe('Money', () => {
  test('calculates exactly, including values above Number safe integer range', () => {
    expect(money('0.10').add(money('0.20')).toString()).toBe('0.30');
    expect(money('9007199254740993.00').add(money('0.01')).toString()).toBe('9007199254740993.01');
    expect(money('100.00').subtract(money('80.00')).toString()).toBe('20.00');
    expect(money('0.00').subtract(money('0.01')).toString()).toBe('-0.01');
  });

  test('serializes fixed scale and normalizes negative zero', () => {
    expect(JSON.stringify(money('25.00'))).toBe('{"amount":"25.00","currency":"BRL"}');
    expect(money('-0.00').toString()).toBe('0.00');
    expect(money('-1.01').negate().toString()).toBe('1.01');
  });

  test('compares signed values and identifies zero', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(money('-0.01').isNegative()).toBe(true);
    expect(money('0.01').isPositive()).toBe(true);
    expect(money('-1.00').isLessThan(money('0.00'))).toBe(true);
    expect(money('1.00').equals(money('1.00'))).toBe(true);
    expect(money('1.00').equals(money('1.01'))).toBe(false);
  });

  test.each(['', 'NaN', 'Infinity', '1e2', '1.001', '1.005', '1', '1.0', '.01', '01.00',
    '+1.00', ' 1.00', '1.00 ', '1,00', '10000000000000000.00'])('rejects invalid decimal %j', value => {
    expect(() => money(value)).toThrow(DomainError);
  });

  test('rejects non-string values at runtime', () => {
    expect(() => money(1 as unknown as string)).toThrow(DomainError);
  });

  test.each(['brl', 'ZZZ', '', ' BRL'])('rejects unsupported currency %j', currency => {
    expect(() => Money.zero(currency)).toThrow(DomainError);
  });

  test('rejects currency conflicts in arithmetic and comparisons', () => {
    const brl = money('1.00');
    const usd = money('1.00', 'USD');
    for (const operation of [() => brl.add(usd), () => brl.subtract(usd),
      () => brl.equals(usd), () => brl.isLessThan(usd)]) {
      expect(operation).toThrow(expect.objectContaining({ code: 'CURRENCY_MISMATCH' }));
    }
  });

  test('enforces both numeric boundaries without changing the operand', () => {
    const max = money('9999999999999999.99');
    expect(max.negate().toString()).toBe('-9999999999999999.99');
    expect(() => max.add(money('0.01'))).toThrow(DomainError);
    expect(() => max.negate().subtract(money('0.01'))).toThrow(DomainError);
    expect(max.toString()).toBe('9999999999999999.99');
  });

  test('is immutable at runtime and returns independent serialized objects', () => {
    const original = money('1.00');
    expect(original.add(Money.zero('BRL'))).not.toBe(original);
    expect(Reflect.set(original, 'currency', 'USD')).toBe(false);
    original.toJSON().amount = '99.00';
    expect(original.toString()).toBe('1.00');
  });
});
