import { Migration } from '@mikro-orm/migrations';

export class Migration202611110002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table inbox_messages (
      consumer_name text not null, message_id text not null, payload_hash text not null,
      received_at timestamptz not null default now(), processed_at timestamptz not null default now(),
      result jsonb not null, primary key(consumer_name,message_id));
      create trigger inbox_immutable before update or delete on inbox_messages
      for each row execute function reject_financial_history_change();`);
  }
  override async down(): Promise<void> { this.addSql(`do $$ begin if exists(select 1 from inbox_messages) then raise exception 'Cannot remove committed inbox history';end if;end $$;drop table inbox_messages`); }
}
