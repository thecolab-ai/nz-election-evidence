// Offline test support for the live adapters: a canned-response fetch and a context builder. No network is touched.
// Used only by ingest/test/parliament_live_*.test.ts.

import type {
  Adapter, AdapterContext, AdapterPage, IngestRecord, Json, SafeFetchRequest, SafeFetchResponse, SourceConfig,
} from "../../../../../supabase/functions/_shared/types.ts";

export interface CannedCall {
  request: SafeFetchRequest;
  body: { [key: string]: Json } | null;
}

export type Responder = (request: SafeFetchRequest, body: { [key: string]: Json } | null, callNumber: number) => string | Promise<string>;

export function cannedFetch(responder: Responder): { fetch: AdapterContext["fetch"]; calls: CannedCall[] } {
  const calls: CannedCall[] = [];
  const fetch = async (request: SafeFetchRequest): Promise<SafeFetchResponse> => {
    const body = request.body ? (JSON.parse(request.body) as { [key: string]: Json }) : null;
    calls.push({ request, body });
    const text = await responder(request, body, calls.length);
    return { status: 200, text, bodySha256: "sha256:fixture", retrievedAt: "2026-09-20T00:00:00.000Z", finalUrl: request.url };
  };
  return { fetch, calls };
}

export function fixtureSource(fields: Partial<SourceConfig> & { official_url: string; allowed_hosts: string[] }): SourceConfig {
  return {
    source_id: "fixture_source", title: "TEST FIXTURE source", publisher: "TEST FIXTURE publisher", adapter_kind: "live_fetch",
    adapter_name: "fixture", view_scope: "current_parliament", snapshot_semantics: "rolling_window", enabled: false,
    access_basis: "public_undocumented_endpoint", ...fields,
  };
}

export interface ContextFields {
  source: SourceConfig;
  fetch: AdapterContext["fetch"];
  resumeCursor?: Json | null;
  maxRecords?: number;
  now?: () => Date;
  deadline?: number;
}

export function fixtureContext(fields: ContextFields): AdapterContext {
  const now = fields.now ?? (() => new Date("2026-09-20T00:00:00Z"));
  return {
    source: fields.source, fetch: fields.fetch, resumeCursor: fields.resumeCursor ?? null, maxRecords: fields.maxRecords ?? 100000,
    deadline: fields.deadline ?? now().getTime() + 3600_000, now,
  };
}

/** Drains an adapter the way the runner does: stops after a page that says done. */
export async function drain(adapter: Adapter, ctx: AdapterContext): Promise<{ pages: AdapterPage[]; records: IngestRecord[]; last: AdapterPage | null }> {
  const pages: AdapterPage[] = [];
  for await (const page of adapter.pages(ctx)) {
    pages.push(page);
    if (page.done) break;
  }
  return { pages, records: pages.flatMap((page) => page.records), last: pages.length ? pages[pages.length - 1] : null };
}

/** The checks the database applies to every payload, restated so a test fails before a write would. */
export function payloadProblems(record: IngestRecord): string[] {
  const problems: string[] = [];
  const text = JSON.stringify(record.safe_payload);
  if (text.length > 8192) problems.push("payload over 8192 characters");
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) problems.push("contact-like string in payload");
  if (/\/(home|data|tmp|Users|var|mnt)\//.test(text)) problems.push("location-like string in payload");
  const walk = (value: Json): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(walk);
    for (const key of Object.keys(value)) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(key)) problems.push(`key ${key} is not snake_case`);
      if (/^(body|html|raw.*|full_text|token|address)$/.test(key)) problems.push(`key ${key} is refused`);
      walk(value[key]);
    }
  };
  walk(record.safe_payload);
  if (record.source_date_text !== undefined && !/^[A-Za-z0-9 ,:+./()-]{1,80}$/.test(record.source_date_text)) problems.push("source_date_text outside the accepted alphabet");
  if (/^[/.]|:\/\/|\s/.test(record.external_record_id)) problems.push("external_record_id has a refused shape");
  return problems;
}
