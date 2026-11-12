import { Migration } from '@mikro-orm/migrations';
export class Migration202611110003 extends Migration {
  override async up():Promise<void>{
    this.addSql(`do $$ declare definition text; begin
      select pg_get_functiondef('verify_wallet_opening()'::regprocedure) into definition;
      execute replace(definition, 'else ''WagerTransactionRejected'' end', 'when t.status=''FAILED'' then ''WagerTransactionFailed'' else ''WagerTransactionRejected'' end');
    end $$;`);
  }
  override async down():Promise<void>{
    this.addSql(`do $$ declare definition text; begin
      if exists(select 1 from wager_transactions where status='FAILED') then raise exception 'Cannot remove FAILED event contract with committed failures'; end if;
      select pg_get_functiondef('verify_wallet_opening()'::regprocedure) into definition;
      execute replace(definition, 'when t.status=''FAILED'' then ''WagerTransactionFailed'' ', '');
    end $$;`);
  }
}
