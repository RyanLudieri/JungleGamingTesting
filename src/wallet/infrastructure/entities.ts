import { DecimalType, EntitySchema } from '@mikro-orm/core';

export class WalletEntity {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class OpeningTransactionEntity {
  id!: string;
  walletId!: string;
  playerId!: string;
  currency!: string;
  amount!: string;
  kind!: string;
  status!: string;
  createdAt!: Date;
}

export class WalletLedgerEntryEntity {
  id!: string;
  walletId!: string;
  transactionId!: string;
  currency!: string;
  amount!: string;
  direction!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

const decimal = () => ({ type: new DecimalType('string'), precision: 18, scale: 2 });
export const WalletSchema = new EntitySchema<WalletEntity>({
  class: WalletEntity, tableName: 'wallets', properties: {
    id: { type: 'uuid', primary: true }, playerId: { type: 'uuid' }, currency: { type: 'string', length: 3 },
    balance: decimal(), version: { type: 'integer' }, createdAt: { type: Date }, updatedAt: { type: Date },
  },
});
export const OpeningTransactionSchema = new EntitySchema<OpeningTransactionEntity>({
  class: OpeningTransactionEntity, tableName: 'wager_transactions', properties: {
    id: { type: 'uuid', primary: true }, walletId: { type: 'uuid' }, playerId: { type: 'uuid' },
    currency: { type: 'string', length: 3 }, amount: decimal(), kind: { type: 'string' },
    status: { type: 'string' }, createdAt: { type: Date },
  },
});
export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryEntity>({
  class: WalletLedgerEntryEntity, tableName: 'wallet_ledger_entries', properties: {
    id: { type: 'uuid', primary: true }, walletId: { type: 'uuid' }, transactionId: { type: 'uuid' },
    currency: { type: 'string', length: 3 }, amount: decimal(), direction: { type: 'string' },
    balanceBefore: decimal(), balanceAfter: decimal(), walletVersion: { type: 'integer' }, createdAt: { type: Date },
  },
});
