// Retries, stated once. A loader call is safe to repeat because every write path is idempotent (content-hashed
// versions, conflict-refusing statistics rows) and every run leaves a checkpoint: a repeat resumes, it never doubles.
// Only two things are retried: a transient database failure, and a run that stopped at its budget ("partial").
// A refused input, a rejected row, a failed count check or a blocked publisher is final: repeating cannot fix it.

import type { LoaderStatus, TargetReceipt } from "./contract.ts";

export interface RetryPolicy { maxAttempts: number; baseDelayMs: number; sleep?: (ms: number) => Promise<void> }

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 2000 };

const TRANSIENT_SQLSTATE = /^(08|53|57P0[123]|40001|40P01)/;
const TRANSIENT_NODE = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT"]);

export function isTransient(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (TRANSIENT_SQLSTATE.test(code) || TRANSIENT_NODE.has(code));
}

const RESUMABLE: ReadonlySet<LoaderStatus> = new Set(["partial"]);

/** Runs `attempt` until it settles. The receipt of the last attempt is returned with the number of attempts made. */
export async function withRetry(attempt: (n: number) => Promise<TargetReceipt>, policy: RetryPolicy = DEFAULT_RETRY): Promise<TargetReceipt> {
  const sleep = policy.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let last: TargetReceipt | null = null;
  for (let n = 1; n <= policy.maxAttempts; n++) {
    try {
      last = await attempt(n);
      last.attempts = n;
      if (!RESUMABLE.has(last.status)) return last;
    } catch (error) {
      if (!isTransient(error) || n === policy.maxAttempts) throw error;
    }
    if (n < policy.maxAttempts) await sleep(policy.baseDelayMs * 2 ** (n - 1));
  }
  return last!;
}
