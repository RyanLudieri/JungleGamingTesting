import { Body, Controller, Get, Post, Param, Query, Headers, Res, Inject, Injectable, HttpException, Catch } from '@nestjs/common';
import type { CanActivate, ExceptionFilter, ArgumentsHost, OnApplicationShutdown } from '@nestjs/common';
import type { Response } from 'express';
import type { Database } from './database';
import { Money } from '../domain/money';
import { DomainError } from '../domain/domain-error';
import { PostgresWalletRepository } from '../../wallet/infrastructure/postgres-wallet.repository';
import { OpenWalletUseCase, WalletAlreadyExistsError } from '../../wallet/application/open-wallet.use-case';
import { ProcessWagerUseCase } from '../../wagering/application/process-wager.use-case';
import { PostgresWagerUnitOfWork } from '../../wagering/infrastructure/postgres-wager-unit-of-work';
import { InvalidWagerInputError, IdempotencyConflictError } from '../../wagering/application/wager-command';
import type { WagerCommand } from '../../wagering/application/wager-command';
import { sqsClient, queueUrl } from '../../messaging/infrastructure/sqs';
import { metrics, count, log, recordResult } from './telemetry';

export const DATABASE=Symbol('DATABASE');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value:string):string { if(!uuid.test(value))throw new InvalidWagerInputError('Invalid UUID');return value.toLowerCase(); }
function object(value:unknown):Record<string,unknown> { if(!value||typeof value!=='object'||Array.isArray(value))throw new InvalidWagerInputError('Object required');return value as Record<string,unknown>; }
/** Extension for an external OIDC identity provider. */
export interface ProviderIdentityPort { authorize(providerId:string):Promise<void> }
@Injectable()
export class NoopProviderGuard implements CanActivate { canActivate():boolean {return true;} }
@Catch()
export class HttpErrors implements ExceptionFilter {
  catch(error:unknown,host:ArgumentsHost):void {
    const res=host.switchToHttp().getResponse<Response>();
    if(error instanceof HttpException){res.status(error.getStatus()).json(error.getResponse());return;}
    const status=error instanceof IdempotencyConflictError||error instanceof WalletAlreadyExistsError?409:
      error instanceof InvalidWagerInputError||error instanceof DomainError?400:503;
    if(status===503){count('infrastructure_errors_total');log('http_infrastructure_error');res.setHeader('Retry-After','1');}
    res.status(status).json({code:status===503?'INFRASTRUCTURE_UNAVAILABLE':(error as {code:string}).code,
      message:status===503?'Retry with the same idempotency key':(error as Error).message});
  }
}
@Controller()
export class ApiController implements OnApplicationShutdown {
  private readonly sqs=sqsClient();
  private readonly wallets:PostgresWalletRepository;
  private readonly wagers:ProcessWagerUseCase;
  constructor(@Inject(DATABASE) private readonly db:Database){
    this.wallets=new PostgresWalletRepository(db);this.wagers=new ProcessWagerUseCase(new PostgresWagerUnitOfWork(db));
  }
  async onApplicationShutdown():Promise<void>{this.sqs.destroy();await this.db.close();}
  @Post('wallets') async open(@Body() body:unknown){
    const b=object(body);id(String(b.playerId));
    let money:Money;try{money=Money.from(b.initialBalance as {amount:string;currency:string});}catch{throw new InvalidWagerInputError('Invalid initial balance');}
    const w=await new OpenWalletUseCase(this.wallets).execute({playerId:String(b.playerId).toLowerCase(),initialBalance:money});
    return {id:w.id,playerId:w.playerId,balance:w.balance.toJSON(),version:w.version};
  }
  @Get('wallets/:walletId') async wallet(@Param('walletId') walletId:string){
    const w=await this.wallets.findById(id(walletId));if(!w)throw new HttpException({code:'NOT_FOUND'},404);
    return {id:w.id,playerId:w.playerId,balance:w.balance.toJSON(),version:w.version};
  }
  @Get('wallets/:walletId/ledger') async ledger(@Param('walletId') walletId:string,@Query('cursor') cursor?:string,@Query('limit') rawLimit?:string){
    await this.wallet(walletId);const limit=rawLimit===undefined?50:Number(rawLimit);
    if(!Number.isInteger(limit)||limit<1||limit>200)throw new InvalidWagerInputError('Limit must be 1..200');
    let after=0;
    if(cursor){try{const c=JSON.parse(Buffer.from(cursor,'base64url').toString()) as {walletId:string;version:number};
      if(c.walletId!==id(walletId)||!Number.isSafeInteger(c.version)||c.version<0)throw new Error();after=c.version;
    }catch{throw new InvalidWagerInputError('Invalid cursor');}}
    const rows=await this.db.em.fork().execute<Array<Record<string,unknown>&{wallet_version:number}>>(`select id,transaction_id,direction,amount,currency,balance_before,balance_after,wallet_version,created_at
      from wallet_ledger_entries where wallet_id=? and wallet_version>? order by wallet_version limit ?`,[id(walletId),after,limit+1]);
    const page=rows.slice(0,limit),last=page.at(-1);
    return {items:page.map(r=>({id:r.id,transactionId:r.transaction_id,direction:r.direction,money:{amount:r.amount,currency:r.currency},
      balanceBefore:{amount:r.balance_before,currency:r.currency},balanceAfter:{amount:r.balance_after,currency:r.currency},walletVersion:r.wallet_version,createdAt:r.created_at})),
      nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({walletId:id(walletId),version:last.wallet_version})).toString('base64url'):null};
  }
  @Post('wagering/transactions') async wager(@Body() body:unknown,@Headers('idempotency-key') key:string|undefined,
    @Headers('x-correlation-id') correlation:string|undefined,@Res({passthrough:true}) response:Response){
    const b=object(body),started=performance.now();const correlationId=correlation&&correlation.length<=200?correlation:crypto.randomUUID();
    const result=await this.wagers.execute({...b,idempotencyKey:key} as unknown as WagerCommand,{correlationId});
    recordResult(result.status,result.idempotentReplay,started);
    log('wager_result',{correlationId,transactionId:result.transactionId,walletId:String(b.walletId),providerId:String(b.providerId),status:result.status});
    response.status(result.status==='FAILED'?500:result.status==='REJECTED'?422:result.status==='PENDING_REFERENCE'?202:200);return result;
  }
  private async transaction(where:string,params:string[]){
    const rows=await this.db.em.fork().execute<Array<{current_result:unknown}>>(`select current_result from wager_transactions where ${where} and kind<>'OPENING'`,params);
    if(!rows[0])throw new HttpException({code:'NOT_FOUND'},404);return rows[0].current_result;
  }
  @Get('wagering/transactions/:transactionId') transactionById(@Param('transactionId') value:string){return this.transaction('id=?',[id(value)]);}
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId') transactionByExternal(@Param('providerId') provider:string,@Param('externalTransactionId') external:string){return this.transaction('provider_id=? and external_transaction_id=?',[provider,external]);}
  @Post('wallets/:walletId/reconciliation') async reconcile(@Param('walletId') value:string,@Res({passthrough:true}) res:Response){
    const walletId=id(value);res.status(200);
    return this.db.em.fork().transactional(async em=>{
      const rows=await em.execute<Array<{balance:string;currency:string}>>('select balance,currency from wallets where id=? for update',[walletId]);
      const w=rows[0];if(!w)throw new HttpException({code:'NOT_FOUND'},404);
      const totals=await em.execute<Array<{total:string;entries:string}>>(`select coalesce(sum(case direction when 'CREDIT' then amount else -amount end),0)::numeric(18,2)::text total,count(*)::text entries from wallet_ledger_entries where wallet_id=?`,[walletId]);
      const stored=Money.from({amount:w.balance,currency:w.currency}),calculated=Money.from({amount:totals[0]!.total,currency:w.currency});
      const consistent=stored.equals(calculated);if(!consistent){count('reconciliation_mismatches_total');log('reconciliation_mismatch',{walletId});}
      return {walletId,storedBalance:stored.toJSON(),calculatedBalance:calculated.toJSON(),difference:stored.subtract(calculated).toJSON(),consistent,checkedEntries:Number(totals[0]!.entries)};
    });
  }
  @Get('health/live') live(){return {status:'ok'};}
  @Get('health/ready') async ready(){await Promise.all([this.db.em.fork().execute('select 1'),queueUrl(this.sqs,'wager-transactions.fifo'),queueUrl(this.sqs,'wager-events.fifo')]);return {status:'ready'};}
  @Get('metrics') async metrics(@Res() res:Response){
    const rows=await this.db.em.fork().execute<Array<{lag:string}>>(`select coalesce(extract(epoch from now()-min(occurred_at)),0)::text lag from outbox_messages where published_at is null`);
    res.type('text/plain').send(metrics()+`wagering_outbox_lag_seconds ${rows[0]!.lag}\n`);
  }
}
