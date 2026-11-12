import { DomainError } from './domain-error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Explicit supported ISO-4217 currencies; all use the challenge's fixed scale.
const SUPPORTED_CURRENCIES = new Set(['BRL', 'USD', 'EUR']);
const MAX_MINOR_UNITS = 999_999_999_999_999_999n;

export class Money {
  private constructor(private readonly minorUnits: bigint, public readonly currency: string) {
    if (minorUnits > MAX_MINOR_UNITS || minorUnits < -MAX_MINOR_UNITS) {
      throw new DomainError('MONEY_OUT_OF_RANGE', 'Money exceeds NUMERIC(18,2) bounds');
    }
    Object.freeze(this);
  }

  /** Signed domain value. External contracts must reject negative amounts. */
  static from({ amount, currency }: MoneyProps): Money {
    if (typeof currency !== 'string' || !SUPPORTED_CURRENCIES.has(currency)) {
      throw new DomainError('UNSUPPORTED_CURRENCY', 'Currency is not supported');
    }
    if (typeof amount !== 'string' || !/^-?(0|[1-9]\d{0,15})\.\d{2}$/.test(amount)) {
      throw new DomainError('INVALID_MONEY', 'Expected a decimal string with exactly two places and at most 16 integer digits');
    }
    return new Money(BigInt(amount.replace('.', '')), currency);
  }

  static zero(currency: string): Money { return Money.from({ amount: '0.00', currency }); }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money { return new Money(-this.minorUnits, this.currency); }
  isZero(): boolean { return this.minorUnits === 0n; }
  isPositive(): boolean { return this.minorUnits > 0n; }
  isNegative(): boolean { return this.minorUnits < 0n; }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits === other.minorUnits;
  }

  toString(): string {
    const absolute = this.minorUnits < 0n ? -this.minorUnits : this.minorUnits;
    return `${this.isNegative() ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
  }

  toJSON(): MoneyProps { return { amount: this.toString(), currency: this.currency }; }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Money currencies must match');
    }
  }
}
