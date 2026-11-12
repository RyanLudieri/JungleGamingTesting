import { expect, test } from 'bun:test';
import { validateCommand, InvalidWagerInputError } from '../../src/wagering/application/wager-command';
import type { WagerCommand } from '../../src/wagering/application/wager-command';
import { WagerTransaction } from '../../src/wagering/domain/wager-transaction';
import { Wallet } from '../../src/wallet/domain/wallet';
import { Money } from '../../src/shared/domain/money';

const command = (): WagerCommand => ({ providerId:'provider', externalTransactionId:'external', idempotencyKey:'key',
  walletId:crypto.randomUUID(), playerId:crypto.randomUUID(), roundId:'round', gameId:'game', kind:'BET',
  money:{ amount:'80.00', currency:'BRL' } });

test('canonical hash ignores key and property order but covers every business field', () => {
  const c = command();
  const hash = validateCommand(c).hash;
  const reversed = Object.fromEntries(Object.entries(c).reverse()) as unknown as WagerCommand;
  expect(validateCommand({ ...reversed, idempotencyKey:'other', money:{ currency:'BRL',amount:'80.00' } }).hash).toBe(hash);
  for (const change of [{ money:{amount:'81.00',currency:'BRL'} }, { roundId:'other' }, { gameId:'other' },
    { kind:'WIN' as const }, { providerId:'other' }, { externalTransactionId:'other' },
    { walletId:crypto.randomUUID() }, { playerId:crypto.randomUUID() }]) {
    expect(validateCommand({ ...c,...change }).hash).not.toBe(hash);
  }
});

test('rejects unsupported operations and invalid monetary contracts before processing', () => {
  for (const change of [{kind:'OPENING'}, {kind:'REFUND'}, {idempotencyKey:''}, {walletId:'bad'},
    {money:{amount:'-1.00',currency:'BRL'}}, {money:{amount:'0.00',currency:'BRL'}},
    {money:{amount:'1.001',currency:'BRL'}}, {referenceExternalTransactionId:'ref'}]) {
    expect(() => validateCommand({ ...command(),...change } as WagerCommand)).toThrow(InvalidWagerInputError);
  }
});

test('transaction transitions are explicit and terminal states cannot be reapplied', () => {
  for (const kind of ['BET','WIN','LOSS'] as const) {
    const c = { ...command(),kind };
    const parsed = validateCommand(c);
    const tx = WagerTransaction.create({ ...c,money:parsed.money,payloadHash:parsed.hash,id:crypto.randomUUID() });
    const wallet = Wallet.open({ id:c.walletId,playerId:c.playerId,initialBalance:Money.from({amount:'100.00',currency:'BRL'}),at:new Date() });
    const entry = tx.apply(wallet,new Date());
    expect(tx.status).toBe('PROCESSED');
    expect(wallet.balance.toString()).toBe(kind==='BET'?'20.00':kind==='WIN'?'180.00':'100.00');
    expect(entry === undefined).toBe(kind==='LOSS');
    expect(() => tx.apply(wallet,new Date())).toThrow('terminal');
    expect(() => tx.reject('INSUFFICIENT_BALANCE')).toThrow('terminal');
  }
});

test('rejection is terminal and rehydration preserves it', () => {
  const c = command(); const parsed = validateCommand(c);
  const props = { ...c, money:parsed.money,payloadHash:parsed.hash,id:crypto.randomUUID() };
  const tx = WagerTransaction.create(props);
  tx.reject('INSUFFICIENT_BALANCE');
  expect(tx.failureCode).toBe('INSUFFICIENT_BALANCE');
  const restored = WagerTransaction.rehydrate({ ...props,status:tx.status,failureCode:tx.failureCode! });
  expect(() => restored.reject('PLAYER_MISMATCH')).toThrow('terminal');
});
