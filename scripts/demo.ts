import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqsClient, queueUrl } from '../src/messaging/infrastructure/sqs';
const base=process.env.API_URL??'http://localhost:3000';
async function request(path:string,body?:unknown,key?:string){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();if(response.status>=500)throw new Error(JSON.stringify(data));return {status:response.status,data};}
const playerId=crypto.randomUUID();
const opened=await request('/wallets',{playerId,initialBalance:{amount:'100.00',currency:'BRL'}});
if(opened.status!==201)throw new Error('Wallet creation failed');
const walletId=(opened.data as {id:string}).id;
const command={providerId:'demo',playerId,walletId,roundId:'demo-round',gameId:'demo-game',kind:'BET',money:{amount:'80.00',currency:'BRL'}};
const bets=[1,2].map(()=>({...command,externalTransactionId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID()}));
const results=await Promise.all(bets.map(c=>request('/wagering/transactions',c,c.idempotencyKey)));
if(results.map(r=>r.status).sort().join(',')!=='200,422')throw new Error('Concurrent bet invariant failed');
const original=results.findIndex(r=>r.status===200);const winner=bets[original]!;
const replay=await request('/wagering/transactions',winner,winner.idempotencyKey);
const sqs=sqsClient();
try{const url=await queueUrl(sqs,'wager-transactions.fifo');await sqs.send(new SendMessageCommand({QueueUrl:url,MessageBody:JSON.stringify({messageId:crypto.randomUUID(),type:'WagerTransactionRequested',occurredAt:new Date().toISOString(),data:{...command,kind:'REFUND',referenceExternalTransactionId:winner.externalTransactionId,externalTransactionId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID()}}),MessageGroupId:walletId,MessageDeduplicationId:crypto.randomUUID()}));}finally{sqs.destroy();}
let balance='';for(let i=0;i<100;i++){balance=((await request(`/wallets/${walletId}`)).data as {balance:{amount:string}}).balance.amount;if(balance==='100.00')break;await Bun.sleep(100);}
if(balance!=='100.00')throw new Error('SQS refund did not complete');
console.log(JSON.stringify({walletId,concurrentStatuses:results.map(r=>r.status),replay:replay.data,reconciliation:(await request(`/wallets/${walletId}/reconciliation`,{})).data},null,2));
