import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';

export function sqsClient(): SQSClient {
  return new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1',
    ...(process.env.SQS_ENDPOINT ? { endpoint: process.env.SQS_ENDPOINT, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {}),
    maxAttempts: 2, requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 } });
}
export async function queueUrl(client: SQSClient, name: string): Promise<string> {
  const result = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!result.QueueUrl) throw new Error('Queue URL missing');
  return result.QueueUrl;
}
export async function initializeQueues(client: SQSClient): Promise<void> {
  const dlq = await client.send(new CreateQueueCommand({ QueueName:'wager-transactions-dlq.fifo', Attributes:{FifoQueue:'true'} }));
  const attributes = await client.send(new GetQueueAttributesCommand({QueueUrl:dlq.QueueUrl!,AttributeNames:['QueueArn']}));
  await client.send(new CreateQueueCommand({QueueName:'wager-transactions.fifo',Attributes:{FifoQueue:'true',VisibilityTimeout:'30',
    RedrivePolicy:JSON.stringify({deadLetterTargetArn:attributes.Attributes!.QueueArn,maxReceiveCount:5})}}));
  await client.send(new CreateQueueCommand({QueueName:'wager-events.fifo',Attributes:{FifoQueue:'true'}}));
}
if (import.meta.main) {
  const client=sqsClient();
  try { await initializeQueues(client); } finally { client.destroy(); }
}
