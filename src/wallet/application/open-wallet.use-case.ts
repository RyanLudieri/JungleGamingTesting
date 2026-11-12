import { Money } from '../../shared/domain/money';
import { Wallet } from '../domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface WalletOpeningRepository {
  saveOpening(wallet: Wallet, entry: WalletLedgerEntry | undefined): Promise<void>;
}

export class WalletAlreadyExistsError extends Error {
  readonly code = 'WALLET_ALREADY_EXISTS';
  constructor() { super('A wallet already exists for this player and currency'); }
}

export class OpenWalletUseCase {
  constructor(private readonly repository: WalletOpeningRepository) {}

  async execute(input: { playerId: string; initialBalance: Money }): Promise<Wallet> {
    const at = new Date();
    const wallet = Wallet.open({ id: crypto.randomUUID(), playerId: input.playerId, initialBalance: input.initialBalance, at });
    const entry = wallet.balance.isPositive() ? WalletLedgerEntry.create({
      id: crypto.randomUUID(), walletId: wallet.id, transactionId: crypto.randomUUID(),
      money: wallet.balance, direction: LedgerDirection.Credit,
      balanceBefore: Money.zero(wallet.currency), balanceAfter: wallet.balance, createdAt: at,
    }) : undefined;
    await this.repository.saveOpening(wallet, entry);
    return wallet;
  }
}
