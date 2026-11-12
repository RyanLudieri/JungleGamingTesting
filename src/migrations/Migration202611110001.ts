import { Migration } from '@mikro-orm/migrations';

export class Migration202611110001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      drop trigger opening_immutable on wager_transactions;
      alter table wager_transactions
        drop constraint wager_kind_check, drop constraint wager_status_check,
        drop constraint wager_request_check, drop constraint wager_failure_check,
        add constraint wager_kind_check check(kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        add constraint wager_status_check check(status in ('PROCESSED','REJECTED','FAILED','PENDING_REFERENCE')),
        add column reference_transaction_id uuid references wager_transactions(id),
        add column current_result jsonb,
        add column reference_attempts integer not null default 0 check(reference_attempts>=0),
        add column next_attempt_at timestamptz, add column expires_at timestamptz,
        add column event_context jsonb,
        add constraint wager_request_check check(kind='OPENING' or
          (provider_id is not null and external_transaction_id is not null and idempotency_key is not null
           and payload_hash is not null and round_id is not null and game_id is not null and result is not null)),
        add constraint wager_failure_check check((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        add constraint wager_pending_check check(status<>'PENDING_REFERENCE' or
          (reference_external_transaction_id is not null and next_attempt_at is not null and expires_at is not null
           and event_context is not null and processed_at is null)),
        add constraint wager_reversal_reference_check check(kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null);
      update wager_transactions set current_result=result;
      update wager_transactions t set reference_transaction_id=r.id from wager_transactions r
        where t.status='PROCESSED' and t.kind='WIN' and t.reference_external_transaction_id=r.external_transaction_id
        and t.provider_id=r.provider_id;
      create unique index one_processed_reversal_per_kind on wager_transactions(reference_transaction_id,kind)
        where kind in ('REFUND','ROLLBACK') and status='PROCESSED';
      create index pending_reference_due_idx on wager_transactions(next_attempt_at,id) where status='PENDING_REFERENCE';
      create function guard_wager_transition() returns trigger language plpgsql as $$
      begin
        if TG_OP='DELETE' or OLD.status<>'PENDING_REFERENCE' then
          raise exception 'Terminal transactions are immutable' using errcode='23514';
        end if;
        if (to_jsonb(NEW)-array['status','failure_code','current_result','processed_at','reference_transaction_id','reference_attempts','next_attempt_at'])
          is distinct from (to_jsonb(OLD)-array['status','failure_code','current_result','processed_at','reference_transaction_id','reference_attempts','next_attempt_at']) then
          raise exception 'Transaction identity and original result are immutable' using errcode='23514';
        end if;
        if NEW.status<>'PENDING_REFERENCE' and NEW.processed_at is null then
          raise exception 'Terminal transition requires timestamp' using errcode='23514';
        end if;
        return NEW;
      end $$;
      create trigger opening_immutable before update or delete on wager_transactions
        for each row execute function guard_wager_transition();
      drop trigger transaction_opening_consistent on wager_transactions;
      create constraint trigger transaction_opening_consistent after insert or update on wager_transactions
        deferrable initially deferred for each row execute function verify_wallet_opening();
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
            ((t.status<>'PROCESSED' or t.kind='LOSS') and e.id is not null) or
            (t.status='PROCESSED' and (t.currency<>w.currency or t.player_id<>w.player_id)) or
            (e.id is not null and (e.direction<>case when t.kind='BET' or (t.kind='ROLLBACK' and (select r.kind from wager_transactions r where r.id=t.reference_transaction_id)<>'BET') then 'DEBIT' else 'CREDIT' end)) or
            (t.kind='OPENING' and (t.status<>'PROCESSED' or e.wallet_version<>1 or e.balance_before<>0))
          )) then raise exception 'Transaction and ledger disagree' using errcode='23514'; end if;
        if exists(select 1 from wager_transactions t where t.wallet_id=wid and t.kind<>'OPENING' and (
          not exists(select 1 from wager_idempotency i where i.transaction_id=t.id and i.provider_id=t.provider_id
            and i.idempotency_key=t.idempotency_key and i.payload_hash=t.payload_hash) or
          not exists(select 1 from outbox_messages o where o.transaction_id=t.id and o.event_type=
            case when t.status='PROCESSED' then 'WagerTransactionProcessed' when t.status='PENDING_REFERENCE' then 'WagerTransactionPendingReference' else 'WagerTransactionRejected' end) or
          (t.status='PROCESSED' and t.kind<>'LOSS' and not exists(select 1 from outbox_messages o
            where o.transaction_id=t.id and o.event_type='WalletBalanceChanged'))
        )) then raise exception 'Transaction requires idempotency and outbox' using errcode='23514'; end if;
        if exists(select 1 from wager_transactions t left join wager_transactions r on r.id=t.reference_transaction_id
          where t.wallet_id=wid and t.status='PROCESSED' and (t.kind in ('REFUND','ROLLBACK') or t.reference_external_transaction_id is not null) and (
            r.id is null or r.status<>'PROCESSED' or r.provider_id is distinct from t.provider_id
            or r.external_transaction_id is distinct from t.reference_external_transaction_id
            or r.wallet_id<>t.wallet_id or r.player_id<>t.player_id or r.currency<>t.currency or r.round_id<>t.round_id
            or (t.kind in ('WIN','REFUND') and r.kind<>'BET')
            or (t.kind='ROLLBACK' and r.kind not in ('BET','WIN','REFUND'))
            or (t.kind in ('REFUND','ROLLBACK') and t.amount<>r.amount)
          )) then raise exception 'Invalid processed reference' using errcode='23514'; end if;
        return null;
      end $$;
`);
  }
  override async down(): Promise<void> {
    this.addSql(`
      do $$ begin
        if exists(select 1 from wager_transactions where kind in ('REFUND','ROLLBACK') or status in ('PENDING_REFERENCE','FAILED')
          or result->>'status'='PENDING_REFERENCE') then
          raise exception 'Cannot revert reference schema while reference history exists';
        end if;
      end $$;
      drop trigger opening_immutable on wager_transactions;
      drop function guard_wager_transition();
      drop index one_processed_reversal_per_kind;
      drop index pending_reference_due_idx;
      alter table wager_transactions drop constraint wager_kind_check, drop constraint wager_status_check,
        drop constraint wager_request_check, drop constraint wager_failure_check,
        drop constraint wager_pending_check, drop constraint wager_reversal_reference_check,
        drop column reference_transaction_id, drop column current_result, drop column reference_attempts,
        drop column next_attempt_at, drop column expires_at, drop column event_context,
        add constraint wager_kind_check check(kind in ('OPENING','BET','WIN','LOSS')),
        add constraint wager_status_check check(status in ('PROCESSED','REJECTED')),
        add constraint wager_request_check check(kind='OPENING' or
          (provider_id is not null and external_transaction_id is not null and idempotency_key is not null
           and payload_hash is not null and round_id is not null and game_id is not null and result is not null and processed_at is not null)),
        add constraint wager_failure_check check((status='REJECTED') = (failure_code is not null));
      create trigger opening_immutable before update or delete on wager_transactions
        for each row execute function reject_financial_history_change();
      drop trigger transaction_opening_consistent on wager_transactions;
      create constraint trigger transaction_opening_consistent after insert on wager_transactions
        deferrable initially deferred for each row execute function verify_wallet_opening();
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
}
