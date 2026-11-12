import { MikroORM, defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletSchema, OpeningTransactionSchema, WalletLedgerEntrySchema } from '../../wallet/infrastructure/entities';
import { Migration202611100001 } from '../../migrations/Migration202611100001';
import { Migration202611100002 } from '../../migrations/Migration202611100002';
import { Migration202611110001 } from '../../migrations/Migration202611110001';
import { Migration202611110002 } from '../../migrations/Migration202611110002';
import { Migration202611110003 } from '../../migrations/Migration202611110003';

export function databaseConfig(clientUrl: string, schema = 'public') {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('Invalid database schema');
  return defineConfig({
    clientUrl,
    schema,
    entities: [WalletSchema, OpeningTransactionSchema, WalletLedgerEntrySchema],
    extensions: [Migrator],
    migrations: { migrationsList: [Migration202611100001, Migration202611100002, Migration202611110001, Migration202611110002, Migration202611110003], transactional: true, allOrNothing: true, snapshot: false },
    driverOptions: { connectionTimeoutMillis: 5000, options: `-c search_path=${schema} -c lock_timeout=3000 -c statement_timeout=10000` },
    pool: { min: 0, max: 10 },
  });
}

export async function connectDatabase(clientUrl = process.env.DATABASE_URL, schema = 'public') {
  if (!clientUrl) throw new Error('DATABASE_URL is required');
  return MikroORM.init(databaseConfig(clientUrl, schema));
}

export type Database = Awaited<ReturnType<typeof connectDatabase>>;
