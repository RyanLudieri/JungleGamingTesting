import { ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { connectDatabase } from '../../shared/infrastructure/database';
import { sqsClient, queueUrl } from './sqs';
import { parseMessage, processMessage } from '../application/process-message';
import { publishOne } from './outbox-publisher';
import { InvalidWagerInputError, IdempotencyConflictError } from '../../wagering/application/wager-command';
import { log, count, metrics, recordResult } from '../../shared/infrastructure/telemetry';

export async function runWorker(mode:string):Promise<void> {
  if(!['consumer','publisher'].includes(mode))throw new Error('Expected consumer or publisher');
  const db=await connectDatabase(process.env.DATABASE_URL,process.env.DATABASE_SCHEMA??'public'),sqs=sqsClient();
  const visibility=process.env.TEST_VISIBILITY_SECONDS==='2'&&new URL(process.env.DATABASE_URL!).pathname==='/wagering_test'?2:30;
  let stopping=false;const stop=()=>{stopping=true;};process.on('SIGTERM',stop);process.on('SIGINT',stop);
  const server=process.env.METRICS_PORT?Bun.serve({port:Number(process.env.METRICS_PORT),fetch:()=>new Response(metrics())}):undefined;
  try {
    const url=await queueUrl(sqs,mode==='consumer'?(process.env.SQS_INPUT_QUEUE??'wager-transactions.fifo'):(process.env.SQS_EVENT_QUEUE??'wager-events.fifo'));
    const dlq=mode==='consumer'?await queueUrl(sqs,process.env.SQS_DLQ_QUEUE??'wager-transactions-dlq.fifo'):'';
    while(!stopping){
      try {
        if(mode==='publisher'){if(!await publishOne(db,sqs,url))await Bun.sleep(250);continue;}
        const received=await sqs.send(new ReceiveMessageCommand({QueueUrl:url,MaxNumberOfMessages:1,WaitTimeSeconds:2,
          VisibilityTimeout:visibility,AttributeNames:['All'],MessageSystemAttributeNames:['ApproximateReceiveCount']}));
        for(const message of received.Messages??[]){
          if(!message.ReceiptHandle)continue;
          if(stopping){await sqs.send(new ChangeMessageVisibilityCommand({QueueUrl:url,ReceiptHandle:message.ReceiptHandle,VisibilityTimeout:0}));continue;}
          const receipt=message.ReceiptHandle,started=performance.now();
          const attempts=Number(message.Attributes?.ApproximateReceiveCount??1);
          const deadLetter=async(code:string)=>{
            await sqs.send(new SendMessageCommand({QueueUrl:dlq,MessageBody:message.Body??'',MessageGroupId:message.MessageId??'invalid',
              MessageDeduplicationId:message.MessageId??crypto.randomUUID(),MessageAttributes:{FailureCode:{DataType:'String',StringValue:code}}}));
            count('dlq_total');log('message_dlq',{messageId:message.MessageId,attempts});
            await sqs.send(new DeleteMessageCommand({QueueUrl:url,ReceiptHandle:receipt}));
          };
          // Extend while SQL or the broker is slow. Lost visibility is safe because the inbox is durable.
          const heartbeat=setInterval(()=>{void sqs.send(new ChangeMessageVisibilityCommand({QueueUrl:url,ReceiptHandle:receipt,VisibilityTimeout:30})).catch(()=>count('visibility_errors_total'));},10_000);
          try {
            const envelope=parseMessage(message.Body??'');
            // If recording exhaustion previously failed, a later delivery must not apply new money.
            const result=await processMessage(db,envelope,attempts>5);
            recordResult(result.status,result.idempotentReplay,started);
            log('message_committed',{correlationId:envelope.messageId,messageId:envelope.messageId,transactionId:result.transactionId,
              walletId:envelope.data.walletId,providerId:envelope.data.providerId,status:result.status});
            // Explicit fault injection is allowed only in the isolated integration-test database.
            if(process.env.TEST_CRASH_AFTER_COMMIT==='1'&&new URL(process.env.DATABASE_URL!).pathname==='/wagering_test')process.exit(86);
            if(result.status==='FAILED')await deadLetter('RETRIES_EXHAUSTED');
            else await sqs.send(new DeleteMessageCommand({QueueUrl:url,ReceiptHandle:receipt}));
          } catch(error:unknown){
            const permanent=error instanceof InvalidWagerInputError||error instanceof IdempotencyConflictError;
            if(permanent||attempts>=5){
              if(!permanent)await processMessage(db,parseMessage(message.Body??''),true);
              // Send then delete: death between these calls may duplicate the DLQ envelope, never lose it.
              await deadLetter(permanent?'INVALID_MESSAGE':'RETRIES_EXHAUSTED');
            }else{
              count('retries_total');log('message_retry',{messageId:message.MessageId,attempts});
              await sqs.send(new ChangeMessageVisibilityCommand({QueueUrl:url,ReceiptHandle:receipt,VisibilityTimeout:visibility===2?1:Math.min(60,2**attempts)}));
            }
          }finally{clearInterval(heartbeat);}
        }
      }catch{count('infrastructure_errors_total');log('worker_infrastructure_error',{mode});await Bun.sleep(1000);}
    }
  }finally{server?.stop();sqs.destroy();await db.close();process.off('SIGTERM',stop);process.off('SIGINT',stop);}
}
if(import.meta.main)await runWorker(process.argv[2]??'consumer');
