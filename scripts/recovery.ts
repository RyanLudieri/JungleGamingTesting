import { connectDatabase } from '../src/shared/infrastructure/database';
import { initializeQueues,sqsClient } from '../src/messaging/infrastructure/sqs';
const docker=process.env.DOCKER_BIN??(process.platform==='win32'?'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe':'docker');
const base=process.env.API_URL??'http://localhost:3000';
async function compose(...args:string[]){const child=Bun.spawn([docker,'compose',...args],{stdout:'ignore',stderr:'inherit'});if(await child.exited!==0)throw new Error('Docker operation failed');}
async function waitFor(check:()=>Promise<boolean>){for(let i=0;i<120;i++){try{if(await check())return;}catch{}await Bun.sleep(500);}throw new Error('Recovery timed out');}
async function post(path:string,body:unknown,key?:string){return fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(body)});}
function assert(value:boolean,message:string){if(!value)throw new Error(message);}
await waitFor(async()=> (await fetch(base+'/health/ready')).status===200);
const playerId=crypto.randomUUID();
const wallet=await(await post('/wallets',{playerId,initialBalance:{amount:'100.00',currency:'BRL'}})).json() as {id:string};
const command={providerId:'recovery-demo',playerId,walletId:wallet.id,externalTransactionId:crypto.randomUUID(),roundId:'r',gameId:'g',kind:'BET',money:{amount:'10.00',currency:'BRL'}};
const key=crypto.randomUUID();let transactionId='';
try{
  await compose('stop','localstack');
  assert((await fetch(base+'/health/live')).status===200,'Liveness must survive broker outage');
  assert((await fetch(base+'/health/ready')).status===503,'Readiness must reject broker outage');
  const response=await post('/wagering/transactions',command,key);assert(response.status===200,'SQL commit must not depend on broker availability');
  transactionId=(await response.json() as {transactionId:string}).transactionId;
  const db=await connectDatabase();try{const rows=await db.em.execute('select id from outbox_messages where transaction_id=? and published_at is null',[transactionId]);assert(rows.length===2,'Committed events must remain pending');}finally{await db.close();}
}finally{
  await compose('start','localstack');
  const sqs=sqsClient();try{await waitFor(async()=>{await initializeQueues(sqs);return true;});}finally{sqs.destroy();}
}
await waitFor(async()=>{const db=await connectDatabase();try{return (await db.em.execute('select id from outbox_messages where transaction_id=? and published_at is null',[transactionId])).length===0;}finally{await db.close();}});
try{
  await compose('stop','postgres');
  assert((await fetch(base+'/health/live')).status===200,'Liveness must survive database outage');
  assert((await fetch(base+'/health/ready')).status===503,'Readiness must reject database outage');
  assert((await post('/wagering/transactions',command,key)).status===503,'Unavailable database must return retryable status');
}finally{await compose('start','postgres');}
await waitFor(async()=> (await fetch(base+'/health/ready')).status===200);
const replay=await(await post('/wagering/transactions',command,key)).json() as {idempotentReplay:boolean;balance:{amount:string}};
assert(replay.idempotentReplay&&replay.balance.amount==='90.00','Restart must preserve original result');
const reconciliation=await(await post(`/wallets/${wallet.id}/reconciliation`,{})).json() as {consistent:boolean};assert(reconciliation.consistent,'Final ledger must reconcile');
console.log(JSON.stringify({brokerRecovery:true,databaseRecovery:true,walletId:wallet.id,reconciliation}));
