import { connectDatabase } from './database';
// Local Compose provisioning only. Production credentials are managed outside this repository.
const db=await connectDatabase();
try{
  await db.em.execute(`do $$ begin if not exists(select 1 from pg_roles where rolname='wagering_app') then
    create role wagering_app login password 'local-runtime-only'; end if; end $$;
    grant connect on database wagering to wagering_app;
    grant usage on schema public to wagering_app;
    grant select on wallets,wager_transactions,wallet_ledger_entries,wager_idempotency,outbox_messages,inbox_messages to wagering_app;
    grant insert on wallets,wager_transactions,wallet_ledger_entries,wager_idempotency,outbox_messages,inbox_messages to wagering_app;
    grant update(balance,version,updated_at) on wallets to wagering_app;
    grant update(status,failure_code,current_result,processed_at,reference_transaction_id,next_attempt_at,reference_attempts) on wager_transactions to wagering_app;
    grant update(attempts,next_attempt_at,published_at) on outbox_messages to wagering_app;`);
}finally{await db.close();}
