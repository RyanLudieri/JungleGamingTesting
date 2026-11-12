const counters=new Map<string,number>(['transactions_processed_total','transactions_rejected_total','transactions_pending_reference_total','transactions_failed_total',
  'duplicates_total','retries_total','dlq_total','lock_conflicts_total','outbox_retries_total','processing_seconds_sum','processing_seconds_count','reconciliation_mismatches_total'].map(k=>[k,0]));
export function count(name:string,amount=1):void { counters.set(name,(counters.get(name)??0)+amount); }
export function metrics():string { return [...counters].map(([k,v])=>`wagering_${k} ${v}`).join('\n')+'\n'; }
export function log(event:string,fields:Record<string,string|number|boolean|undefined>={}):void {
  console.log(JSON.stringify({timestamp:new Date().toISOString(),event,...fields}));
}
export function recordResult(status:string,replay:boolean,started:number):void {
  count(`transactions_${status.toLowerCase()}_total`);
  if(replay) count('duplicates_total');
  count('processing_seconds_sum',(performance.now()-started)/1000);count('processing_seconds_count');
}
