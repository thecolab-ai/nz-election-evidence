// Shared pieces for the Parliament live-fetch adapters.
// Erasable TypeScript only: runs unchanged in Node 24 and in Deno.

import { type AdapterContext, IngestError, type IngestRecord, type Json } from "../../../../../supabase/functions/_shared/types.ts";
import { type BuiltRecord, toIngestRecord, UnusableRecord } from "../payload.ts";

/** Time kept in hand before the run deadline, as the current-bills adapter does. */
export const DEADLINE_MARGIN_MS = 15_000;

export type Options = { [key: string]: Json } | undefined;

export function optionInt(options: Options, key: string, fallback: number, min: number, max: number): number {
  const value = options?.[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new IngestError("invalid_adapter_options", `adapter option ${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function optionDay(options: Options, key: string, fallback: string): string {
  const value = options?.[key] ?? fallback;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + "T00:00:00Z"))) {
    throw new IngestError("invalid_adapter_options", `adapter option ${key} must be a YYYY-MM-DD date`);
  }
  return value;
}

export function parseJsonObject(body: string, what: string): { [key: string]: unknown } {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new IngestError("parse_error", `${what} did not return JSON`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new IngestError("parse_error", `${what} did not return a JSON object`);
  return data as { [key: string]: unknown };
}

export function asRow(raw: unknown, what: string): { [key: string]: unknown } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new IngestError("parse_error", `${what} result is not an object`);
  return raw as { [key: string]: unknown };
}

/** Runs a payload builder; a row with no usable publisher id or link is a parse fault, never a silently skipped row. */
export async function builtRecord(build: () => BuiltRecord, retrievedAt: string): Promise<IngestRecord> {
  let built: BuiltRecord;
  try {
    built = build();
  } catch (error) {
    if (error instanceof UnusableRecord) throw new IngestError("parse_error", error.message);
    throw error;
  }
  return await toIngestRecord(built, retrievedAt);
}

/**
 * The runner stores at most maxRecords records per run and drops the rest of a page while still saving that page's
 * cursor. So a further request is made only when a full page still fits: nothing fetched is ever left unstored behind
 * an advanced checkpoint.
 */
export function roomFor(ctx: AdapterContext, emitted: number, nextBatch: number): boolean {
  return emitted + nextBatch <= ctx.maxRecords && ctx.now().getTime() <= ctx.deadline - DEADLINE_MARGIN_MS;
}

/** First page to read after a page-size change, so that no record before the old position is skipped. */
export function convertPage(nextPage: number, oldSize: number, newSize: number): number {
  if (oldSize === newSize) return nextPage;
  return Math.floor(((nextPage - 1) * oldSize) / newSize) + 1;
}

export function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
