import { Migration } from '@mikro-orm/migrations';

/** Opening-only schema. Wager processing will extend it in a later migration. */
export class Migration202611100001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key, player_id uuid not null,
        currency varchar(3) not null check (currency in ('BRL','USD','EUR')),
        balance numeric(18,2) not null check (balance >= 0 and balance <> 'NaN'::numeric),
        version integer not null check (version >= 1),
        created_at timestamptz not null, updated_at timestamptz not null,
        constraint wallets_player_currency_unique unique(player_id, currency),
        unique(id, player_id, currency)
      );
      create table wager_transactions (
        id uuid primary key, wallet_id uuid not null, player_id uuid not null,
        currency varchar(3) not null, amount numeric(18,2) not null check(amount > 0 and amount <> 'NaN'::numeric),
        kind text not null check(kind = 'OPENING'), status text not null check(status = 'PROCESSED'),
        created_at timestamptz not null,
        foreign key(wallet_id, player_id, currency) references wallets(id, player_id, currency),
        unique(id, wallet_id, currency, amount), unique(wallet_id)
      );
      create table wallet_ledger_entries (
        id uuid primary key, wallet_id uuid not null references wallets(id), transaction_id uuid not null,
        currency varchar(3) not null, amount numeric(18,2) not null check(amount > 0 and amount <> 'NaN'::numeric),
        direction text not null check(direction in ('CREDIT','DEBIT')),
        balance_before numeric(18,2) not null check(balance_before >= 0 and balance_before <> 'NaN'::numeric),
        balance_after numeric(18,2) not null check(balance_after >= 0 and balance_after <> 'NaN'::numeric),
        wallet_version integer not null check(wallet_version >= 1), created_at timestamptz not null,
        check(balance_after = balance_before + case when direction='CREDIT' then amount else -amount end),
        foreign key(transaction_id, wallet_id, currency, amount) references wager_transactions(id, wallet_id, currency, amount),
        unique(transaction_id, wallet_id), unique(wallet_id, wallet_version)
      );
      create index ledger_wallet_cursor_idx on wallet_ledger_entries(wallet_id, created_at, id);

      create function reject_financial_history_change() returns trigger language plpgsql as $$
      begin
        raise exception 'Financial history is immutable' using errcode='23514';
      end $$;
      create trigger ledger_immutable before update or delete on wallet_ledger_entries
        for each row execute function reject_financial_history_change();
      create trigger ledger_no_truncate before truncate on wallet_ledger_entries
        for each statement execute function reject_financial_history_change();
      create trigger opening_immutable before update or delete on wager_transactions
        for each row execute function reject_financial_history_change();
      create trigger opening_no_truncate before truncate on wager_transactions
        for each statement execute function reject_financial_history_change();

      create function verify_wallet_opening() returns trigger language plpgsql as $$
      declare wid uuid; w wallets%rowtype; entries bigint; openings bigint; total numeric;
      begin
        if TG_TABLE_NAME = 'wallets' then wid := NEW.id; else wid := NEW.wallet_id; end if;
        select * into w from wallets where id=wid for update;
        if not found then return null; end if;
        select count(*), coalesce(sum(case when direction='CREDIT' then amount else -amount end),0)
          into entries,total from wallet_ledger_entries where wallet_id=wid;
        select count(*) into openings from wager_transactions where wallet_id=wid;
        if w.version <> 1 or w.balance <> total or
          (w.balance=0 and (entries<>0 or openings<>0)) or
          (w.balance>0 and (entries<>1 or openings<>1)) or
          exists(select 1 from wallet_ledger_entries where wallet_id=wid and
            (direction<>'CREDIT' or balance_before<>0 or balance_after<>w.balance or wallet_version<>1)) then
          raise exception 'Wallet opening, transaction and ledger must agree' using errcode='23514';
        end if;
        return null;
      end $$;
      create constraint trigger wallet_opening_consistent after insert or update on wallets
        deferrable initially deferred for each row execute function verify_wallet_opening();
      create constraint trigger ledger_opening_consistent after insert on wallet_ledger_entries
        deferrable initially deferred for each row execute function verify_wallet_opening();
      create constraint trigger transaction_opening_consistent after insert on wager_transactions
        deferrable initially deferred for each row execute function verify_wallet_opening();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop table wallet_ledger_entries;
      drop table wager_transactions;
      drop table wallets;
      drop function verify_wallet_opening();
      drop function reject_financial_history_change();
    `);
  }
}
