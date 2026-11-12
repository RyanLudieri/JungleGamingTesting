import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { Database } from '../../shared/infrastructure/database';
import { Money } from '../../shared/domain/money';
import { Wallet } from '../domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WalletAlreadyExistsError } from '../application/open-wallet.use-case';
import type { WalletOpeningRepository } from '../application/open-wallet.use-case';
import { WalletEntity, OpeningTransactionEntity, WalletLedgerEntryEntity } from './entities';

export class PostgresWalletRepository implements WalletOpeningRepository {
  constructor(private readonly orm: Database) {}

  async saveOpening(wallet: Wallet, entry: WalletLedgerEntry | undefined): Promise<void> {
    try {
      await this.orm.em.fork().transactional(async em => {
        em.persist(em.create(WalletEntity, { id: wallet.id, playerId: wallet.playerId,
          currency: wallet.currency, balance: wallet.balance.toString(), version: wallet.version,
          createdAt: wallet.createdAt, updatedAt: wallet.updatedAt }));
        await em.flush();
        if (entry) {
          em.persist(em.create(OpeningTransactionEntity, { id: entry.transactionId,
            walletId: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
            amount: entry.money.toString(), kind: 'OPENING', status: 'PROCESSED', createdAt: entry.createdAt }));
          await em.flush();
          em.persist(em.create(WalletLedgerEntryEntity, { id: entry.id, walletId: entry.walletId,
            transactionId: entry.transactionId, currency: entry.money.currency, amount: entry.money.toString(),
            direction: entry.direction, balanceBefore: entry.balanceBefore.toString(),
            balanceAfter: entry.balanceAfter.toString(), walletVersion: wallet.version, createdAt: entry.createdAt }));
          await em.flush();
        }
      });
    } catch (error: unknown) {
      if (error instanceof UniqueConstraintViolationException &&
        error.message.includes('wallets_player_currency_unique')) throw new WalletAlreadyExistsError();
      throw error;
    }
  }

  async findById(id: string): Promise<Wallet | null> {
    const row = await this.orm.em.fork().findOne(WalletEntity, { id });
    return row ? Wallet.rehydrate({ ...row, balance: Money.from({ amount: row.balance, currency: row.currency }) }) : null;
  }

  async findLedger(walletId: string): Promise<WalletLedgerEntry[]> {
    const rows = await this.orm.em.fork().find(WalletLedgerEntryEntity, { walletId }, { orderBy: { walletVersion: 'asc' } });
    return rows.map(row => WalletLedgerEntry.rehydrate({ ...row, direction: row.direction as LedgerDirection,
      money: Money.from({ amount: row.amount, currency: row.currency }),
      balanceBefore: Money.from({ amount: row.balanceBefore, currency: row.currency }),
      balanceAfter: Money.from({ amount: row.balanceAfter, currency: row.currency }),
    }));
  }
}
