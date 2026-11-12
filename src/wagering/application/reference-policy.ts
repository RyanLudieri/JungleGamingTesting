export interface ReferencePolicy { ttlMs: number; initialBackoffMs: number; maxBackoffMs: number }
export const defaultReferencePolicy: Readonly<ReferencePolicy> = Object.freeze({ttlMs:900_000,initialBackoffMs:1000,maxBackoffMs:60_000});
export function validateReferencePolicy(policy: ReferencePolicy): ReferencePolicy {
  if (Object.values(policy).some(v=>!Number.isSafeInteger(v)||v<=0)
    || policy.initialBackoffMs>policy.maxBackoffMs) throw new Error('Invalid reference retry policy');
  return {...policy};
}
export function nextReferenceAttempt(at: Date, attempts: number, expiresAt: Date, policy: ReferencePolicy): Date {
  const delay = Math.min(policy.maxBackoffMs,policy.initialBackoffMs*2**Math.min(attempts,30));
  return new Date(Math.min(at.getTime()+delay,expiresAt.getTime()));
}
