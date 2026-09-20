// Shared-secret check for the scheduled caller. pg_cron reads the same value from Supabase Vault.

export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  // Compare full length of both so timing does not reveal where they differ.
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i % Math.max(left.length, 1)] ?? 0) ^ (right[i % Math.max(right.length, 1)] ?? 0);
  return diff === 0;
}

export function authoriseCronRequest(headerValue: string | null, expected: string | undefined): { ok: boolean; status: number; reason: string } {
  if (!expected || expected.length < 32) return { ok: false, status: 503, reason: "function secret is not configured" };
  if (!headerValue) return { ok: false, status: 401, reason: "missing credentials" };
  if (!timingSafeEqual(headerValue, expected)) return { ok: false, status: 401, reason: "bad credentials" };
  return { ok: true, status: 200, reason: "ok" };
}

export interface IngestRequestBody {
  source_id: string;
  schedule_key?: string;
  trigger_kind: "cron" | "function_readback";
  max_runtime_seconds: number;
  max_records: number;
}

/** Strict body validation. The caller picks a configured source by id; it can never supply a URL. */
export function parseIngestRequest(raw: unknown): IngestRequestBody {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("body must be a JSON object");
  const body = raw as { [key: string]: unknown };
  const allowedKeys = ["source_id", "schedule_key", "trigger_kind", "max_runtime_seconds", "max_records"];
  for (const key of Object.keys(body)) if (!allowedKeys.includes(key)) throw new Error(`unexpected field ${key}`);
  if (typeof body.source_id !== "string" || !/^[a-z][a-z0-9_]{2,62}$/.test(body.source_id)) throw new Error("bad source_id");
  if (body.schedule_key !== undefined && (typeof body.schedule_key !== "string" || !/^[a-z][a-z0-9_-]{2,60}$/.test(body.schedule_key))) throw new Error("bad schedule_key");
  const trigger = body.trigger_kind ?? "cron";
  if (trigger !== "cron" && trigger !== "function_readback") throw new Error("bad trigger_kind");
  const runtime = Number(body.max_runtime_seconds ?? 60);
  const records = Number(body.max_records ?? 500);
  if (!Number.isInteger(runtime) || runtime < 10 || runtime > 140) throw new Error("max_runtime_seconds must be 10-140");
  if (!Number.isInteger(records) || records < 1 || records > 2000) throw new Error("max_records must be 1-2000");
  return { source_id: body.source_id, schedule_key: body.schedule_key as string | undefined, trigger_kind: trigger, max_runtime_seconds: runtime, max_records: records };
}
