export type DomainErrorCode =
  | 'INVALID_MONEY' | 'MONEY_OUT_OF_RANGE' | 'UNSUPPORTED_CURRENCY'
  | 'CURRENCY_MISMATCH' | 'INVALID_AMOUNT' | 'INSUFFICIENT_BALANCE'
  | 'INVALID_LEDGER_ENTRY' | 'INVALID_WALLET' | 'INVALID_MOVEMENT';

export class DomainError extends Error {
  constructor(public readonly code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}
