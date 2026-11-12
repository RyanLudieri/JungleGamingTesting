import { createHash } from 'node:crypto';
import { Money } from '../../shared/domain/money';
import type { MoneyProps } from '../../shared/domain/money';
import type { WagerKind } from '../domain/wager-transaction';

export interface WagerCommand {
  providerId: string; externalTransactionId: string; idempotencyKey: string;
  walletId: string; playerId: string; roundId: string; gameId: string;
  kind: WagerKind; money: MoneyProps; referenceExternalTransactionId?: string;
}
export class InvalidWagerInputError extends Error { readonly code = 'INVALID_PAYLOAD'; }
export class IdempotencyConflictError extends Error { readonly code = 'IDEMPOTENCY_CONFLICT'; }

export function validateCommand(input: WagerCommand): { command: WagerCommand; money: Money; hash: string } {
  const ids = [input.providerId, input.externalTransactionId, input.idempotencyKey,
    input.walletId, input.playerId, input.roundId, input.gameId];
  if (ids.some(v => typeof v !== 'string' || v.length === 0 || v.length > 200 || v.trim() !== v)) {
    throw new InvalidWagerInputError('Identifiers must be nonempty strings of at most 200 characters');
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(input.walletId) || !uuid.test(input.playerId) || !['BET','WIN','LOSS','REFUND','ROLLBACK'].includes(input.kind)) {
    throw new InvalidWagerInputError('Invalid wallet/player UUID or kind');
  }
  let money: Money;
  try { money = Money.from(input.money); } catch { throw new InvalidWagerInputError('Invalid money'); }
  if (money.isNegative() || (input.kind !== 'LOSS' && money.isZero())) {
    throw new InvalidWagerInputError('BET/WIN require positive amounts; LOSS requires a nonnegative amount');
  }
  if (['REFUND','ROLLBACK'].includes(input.kind) && !input.referenceExternalTransactionId) {
    throw new InvalidWagerInputError('Reversal requires a reference');
  }
  if (input.referenceExternalTransactionId !== undefined && (!['WIN','REFUND','ROLLBACK'].includes(input.kind)
    || typeof input.referenceExternalTransactionId !== 'string' || !input.referenceExternalTransactionId.trim()
    || input.referenceExternalTransactionId.length > 200 || input.referenceExternalTransactionId.trim() !== input.referenceExternalTransactionId)) {
    throw new InvalidWagerInputError('Invalid reference');
  }
  if (input.referenceExternalTransactionId === input.externalTransactionId) throw new InvalidWagerInputError('Self reference is invalid');
  const business = {
    externalTransactionId: input.externalTransactionId, gameId: input.gameId, kind: input.kind,
    money: money.toJSON(), playerId: input.playerId.toLowerCase(), providerId: input.providerId,
    ...(input.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: input.referenceExternalTransactionId }),
    roundId: input.roundId, walletId: input.walletId.toLowerCase(),
  };
  // Both object levels are constructed in lexicographic key order; transport is excluded.
  const hash = createHash('sha256').update(JSON.stringify(business)).digest('hex');
  return { command: { ...business, idempotencyKey: input.idempotencyKey }, money, hash };
}
