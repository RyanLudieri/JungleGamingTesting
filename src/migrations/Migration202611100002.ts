import { Migration } from '@mikro-orm/migrations';

export class Migration202611100002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_transactions_wallet_id_key,
        drop constraint wager_transactions_kind_check,
        drop constraint wager_transactions_status_check,
        drop constraint wager_transactions_amount_check,
        drop constraint wager_transactions_wallet_id_player_id_currency_fkey,
        add foreign key(wallet_id) references wallets(id),
        add constraint wager_kind_check check(kind in ('OPENING','BET','WIN','LOSS')),
        add constraint wager_status_check check(status in ('PROCESSED','REJECTED')),
        add constraint wager_amount_check check(amount >= 0 and amount <> 'NaN'::numeric and (kind='LOSS' or amount>0)),
        add column provider_id text,
        add column external_transaction_id text,
        add column idempotency_key text,
        add column payload_hash text,
        add column round_id text,
        add column game_id text,
        add column reference_external_transaction_id text,
        add column failure_code text,
        add column result jsonb,
        add column processed_at timestamptz,
        add constraint wager_external_unique unique(provider_id, external_transaction_id),
        add constraint wager_request_check check(kind='OPENING' or
          (provider_id is not null and external_transaction_id is not null and idempotency_key is not null
           and payload_hash is not null and round_id is not null and game_id is not null and result is not null
           and processed_at is not null)),
        add constraint wager_failure_check check((status='REJECTED') = (failure_code is not null));
      create unique index one_opening_per_wallet on wager_transactions(wallet_id) where kind='OPENING';
      create table wager_idempotency (
        provider_id text not null, idempotency_key text not null,
        payload_hash text not null, transaction_id uuid not null references wager_transactions(id),
        primary key(provider_id, idempotency_key)
      );
      create table outbox_messages (
        id uuid primary key, aggregate_id uuid not null references wallets(id),
        transaction_id uuid not null references wager_transactions(id), event_type text not null,
        payload jsonb not null, occurred_at timestamptz not null,
        attempts integer not null default 0 check(attempts >= 0),
        next_attempt_at timestamptz, published_at timestamptz,
        unique(transaction_id, event_type)
      );
      create index outbox_pending_idx on outbox_messages(occurred_at,id) where published_at is null;
      create trigger idempotency_immutable before update or delete on wager_idempotency
        for each row execute function reject_financial_history_change();

      create or replace function verify_wallet_opening() returns trigger language plpgsql as $$
      declare wid uuid; w wallets%rowtype; total numeric; movements bigint;
      begin
        if TG_TABLE_NAME = 'wallets' then wid := NEW.id; else wid := NEW.wallet_id; end if;
        select * into w from wallets where id=wid for update;
        if not found then return null; end if;
        select coalesce(sum(case when e.direction='CREDIT' then e.amount else -e.amount end),0),
          count(*) filter(where t.kind<>'OPENING') into total,movements
          from wallet_ledger_entries e join wager_transactions t on t.id=e.transaction_id where e.wallet_id=wid;
        if w.balance<>total or w.version<>1+movements then
          raise exception 'Wallet balance/version does not reconcile with ledger' using errcode='23514';
        end if;
        if exists(select 1 from (
          select balance_before, lag(balance_after,1,0::numeric) over(order by wallet_version) as previous,
            wallet_version, row_number() over(order by wallet_version) as position
          from wallet_ledger_entries where wallet_id=wid
        ) e where e.balance_before<>e.previous or e.wallet_version<>e.position+
          case when exists(select 1 from wager_transactions where wallet_id=wid and kind='OPENING') then 0 else 1 end) then
          raise exception 'Ledger chain is invalid' using errcode='23514';
        end if;
        if exists(select 1 from wager_transactions t left join wallet_ledger_entries e on e.transaction_id=t.id
          where t.wallet_id=wid and (
            (t.status='PROCESSED' and t.kind<>'LOSS' and e.id is null) or
            ((t.status='REJECTED' or t.kind='LOSS') and e.id is not null) or
            (t.status='PROCESSED' and (t.currency<>w.currency or t.player_id<>w.player_id)) or
            (e.id is not null and (e.direction<>case when t.kind='BET' then 'DEBIT' else 'CREDIT' end)) or
            (t.kind='OPENING' and (t.status<>'PROCESSED' or e.wallet_version<>1 or e.balance_before<>0))
          )) then raise exception 'Transaction and ledger disagree' using errcode='23514'; end if;
        if exists(select 1 from wager_transactions t where t.wallet_id=wid and t.kind<>'OPENING' and (
          not exists(select 1 from wager_idempotency i where i.transaction_id=t.id and i.provider_id=t.provider_id
            and i.idempotency_key=t.idempotency_key and i.payload_hash=t.payload_hash) or
          not exists(select 1 from outbox_messages o where o.transaction_id=t.id and o.event_type=
            case when t.status='PROCESSED' then 'WagerTransactionProcessed' else 'WagerTransactionRejected' end) or
          (t.status='PROCESSED' and t.kind<>'LOSS' and not exists(select 1 from outbox_messages o
            where o.transaction_id=t.id and o.event_type='WalletBalanceChanged'))
        )) then raise exception 'Transaction requires idempotency and outbox' using errcode='23514'; end if;
        return null;
      end $$;
    `);
  }

  override async down(): Promise<void> {
    // A rollback must never erase committed wager history to fit an older schema.
    this.addSql(`do $$ begin
      if exists(select 1 from wager_transactions where kind<>'OPENING') then
        raise exception 'Cannot revert wagering schema while wager history exists';
      end if;
    end $$;
    drop table outbox_messages;
    drop table wager_idempotency;
    drop index one_opening_per_wallet;
    alter table wager_transactions drop constraint wager_kind_check, drop constraint wager_status_check,
      drop constraint wager_amount_check, drop constraint wager_request_check, drop constraint wager_failure_check,
      drop constraint wager_external_unique, drop constraint wager_transactions_wallet_id_fkey,
      drop column provider_id, drop column external_transaction_id, drop column idempotency_key,
      drop column payload_hash, drop column round_id, drop column game_id,
      drop column reference_external_transaction_id, drop column failure_code, drop column result, drop column processed_at,
      add constraint wager_transactions_wallet_id_key unique(wallet_id),
      add constraint wager_transactions_kind_check check(kind='OPENING'),
      add constraint wager_transactions_status_check check(status='PROCESSED'),
      add constraint wager_transactions_amount_check check(amount>0 and amount<>'NaN'::numeric),
      add constraint wager_transactions_wallet_id_player_id_currency_fkey foreign key(wallet_id,player_id,currency)
        references wallets(id,player_id,currency);
    create or replace function verify_wallet_opening() returns trigger language plpgsql as $$
    declare wid uuid; w wallets%rowtype; entries bigint; openings bigint; total numeric;
    begin
      if TG_TABLE_NAME='wallets' then wid:=NEW.id; else wid:=NEW.wallet_id; end if;
      select * into w from wallets where id=wid for update;
      if not found then return null; end if;
      select count(*),coalesce(sum(case when direction='CREDIT' then amount else -amount end),0)
        into entries,total from wallet_ledger_entries where wallet_id=wid;
      select count(*) into openings from wager_transactions where wallet_id=wid;
      if w.version<>1 or w.balance<>total or (w.balance=0 and (entries<>0 or openings<>0))
        or (w.balance>0 and (entries<>1 or openings<>1)) or exists(select 1 from wallet_ledger_entries
          where wallet_id=wid and (direction<>'CREDIT' or balance_before<>0 or balance_after<>w.balance or wallet_version<>1)) then
        raise exception 'Wallet opening, transaction and ledger must agree' using errcode='23514';
      end if;
      return null;
    end $$;`);
  }
}
