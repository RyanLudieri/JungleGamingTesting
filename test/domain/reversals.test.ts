import { expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/wallet/domain/wallet';
import { WagerTransaction } from '../../src/wagering/domain/wager-transaction';
import type { WagerKind, WagerReference } from '../../src/wagering/domain/wager-transaction';
import { defaultReferencePolicy, nextReferenceAttempt } from '../../src/wagering/application/reference-policy';

const money = (amount: string) => Money.from({amount,currency:'BRL'});
const props = (kind: WagerKind) => ({id:'tx',providerId:'p',externalTransactionId:'external',idempotencyKey:'key',
  payloadHash:'hash',walletId:'w',playerId:'player',roundId:'r',gameId:'g',kind,money:money('20.00'),referenceExternalTransactionId:'ref'});
const reference = (kind = 'BET'): WagerReference => ({id:'ref',walletId:'w',playerId:'player',currency:'BRL',roundId:'r',kind,status:'PROCESSED',amount:'20.00'});

test.each([['REFUND','BET','120.00'],['ROLLBACK','BET','120.00'],['ROLLBACK','WIN','80.00'],['ROLLBACK','REFUND','80.00']])(
  '%s reverses %s with correct direction', (kind,refKind,balance) => {
    const tx=WagerTransaction.create(props(kind as WagerKind));
    const wallet=Wallet.open({id:'w',playerId:'player',initialBalance:money('100.00'),at:new Date()});
    tx.markPendingReference();
    expect(tx.apply(wallet,new Date(),reference(refKind))?.isBalanced()).toBe(true);
    expect(wallet.balance.toString()).toBe(balance!);
    expect(tx.referenceTransactionId).toBe('ref');
    expect(()=>tx.markPendingReference()).toThrow('terminal');
  });

test('reference validation rejects mismatched identity, amount, type and terminal rejection',()=>{
  const tx=WagerTransaction.create(props('REFUND'));
  for(const change of [{walletId:'other'},{playerId:'other'},{currency:'USD'},{roundId:'other'},
    {amount:'10.00'},{kind:'WIN'},{status:'REJECTED'},{status:'FAILED'}]){
    expect(tx.referenceFailure({...reference(),...change})).toBe('INVALID_REFERENCE');
  }
  expect(()=>WagerTransaction.create({...props('REFUND'),referenceExternalTransactionId:undefined} as unknown as Parameters<typeof WagerTransaction.create>[0])).toThrow();
});

test('backoff doubles, caps at 60 seconds and never schedules beyond TTL',()=>{
  const now=new Date('2030-01-01T00:00:00Z');const expires=new Date(now.getTime()+900000);
  expect(nextReferenceAttempt(now,0,expires,defaultReferencePolicy).getTime()-now.getTime()).toBe(1000);
  expect(nextReferenceAttempt(now,1,expires,defaultReferencePolicy).getTime()-now.getTime()).toBe(2000);
  expect(nextReferenceAttempt(now,20,expires,defaultReferencePolicy).getTime()-now.getTime()).toBe(60000);
  expect(nextReferenceAttempt(now,20,new Date(now.getTime()+123),defaultReferencePolicy).getTime()-now.getTime()).toBe(123);
});
