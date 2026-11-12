import { connectDatabase } from '../../shared/infrastructure/database';
import { PostgresWagerUnitOfWork } from './postgres-wager-unit-of-work';
import { ProcessWagerUseCase } from '../application/process-wager.use-case';
import { defaultReferencePolicy, validateReferencePolicy } from '../application/reference-policy';

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value)<=0) throw new Error(`Invalid ${name}`);
  return Number(value);
}
export async function runReferenceWorker(): Promise<void> {
  const policy = validateReferencePolicy({ttlMs:positiveInteger('REFERENCE_TTL_MS',defaultReferencePolicy.ttlMs),
    initialBackoffMs:positiveInteger('REFERENCE_BACKOFF_MS',defaultReferencePolicy.initialBackoffMs),
    maxBackoffMs:positiveInteger('REFERENCE_MAX_BACKOFF_MS',defaultReferencePolicy.maxBackoffMs)});
  const interval = positiveInteger('REFERENCE_POLL_MS',500);
  const orm = await connectDatabase(process.env.DATABASE_URL,process.env.DATABASE_SCHEMA ?? 'public');
  const useCase = new ProcessWagerUseCase(new PostgresWagerUnitOfWork(orm),policy);
  let stopping = false;
  const stop = () => { stopping=true; };
  process.on('SIGTERM',stop); process.on('SIGINT',stop);
  try {
    while (!stopping) {
      try { if (!await useCase.retryOne()) await Bun.sleep(interval); }
      catch {
        console.error(JSON.stringify({event:'reference_worker_retry',code:'REFERENCE_WORKER_ERROR',at:new Date().toISOString()}));
        await Bun.sleep(interval);
      }
    }
  } finally {
    process.off('SIGTERM',stop); process.off('SIGINT',stop);
    await orm.close(true);
  }
}
if (import.meta.main) runReferenceWorker().catch(() => { console.error('Reference worker startup failed'); process.exitCode=1; });
