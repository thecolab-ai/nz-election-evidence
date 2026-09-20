// Election family export import: load -> preflight the whole file -> replay the record history in waves.
//
// The store refuses two different contents for one record inside one run. A record's history is therefore
// replayed as a sequence of runs ("waves"): wave k carries the k-th kept version of every record that has a
// later one, and the last wave carries the latest version of EVERY record. Only the last wave can be a
// complete snapshot, so an earlier wave can never tombstone a record it simply does not mention.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { contentHash } from "../../../../supabase/functions/_shared/canonical.ts";
import {
  type Adapter, type AdapterContext, type AdapterPage, IngestError, type IngestRecord, type Json,
} from "../../../../supabase/functions/_shared/types.ts";
import { contractProblem } from "./contracts.ts";
import { type AnyProductId, type ExportManifest, safeDigest, type VersionedExportRow } from "./exporter.ts";
import { letterHex } from "./mapping.ts";

export const FAMILY_ADAPTER_VERSION = "1.0.0";
const PROJECTION_VERSION = 1;
const PAGE_ROWS = 400;

export interface ProductPin { sha256: string; rows: number; records: number; waves: number }

export interface LoadedProduct {
  product: AnyProductId;
  rows: VersionedExportRow[];
  digest: { sha256: string; bytes: number; rows: number };
}

function refuse(message: string): never {
  throw new IngestError("input_not_accepted", message);
}

/** File locations come from the environment only and never appear in a message. */
export function exportLocation(product: AnyProductId, env: { [key: string]: string | undefined }, name = `${product}.jsonl`): string {
  const direct = env[`EVIDENCE_EXPORT_ELECTION_${product}`];
  if (direct && name.endsWith(".jsonl")) return direct;
  const dir = env.EVIDENCE_EXPORT_ELECTION_DIR;
  if (!dir) throw new IngestError("missing_input", `set EVIDENCE_EXPORT_ELECTION_DIR (or EVIDENCE_EXPORT_ELECTION_${product}) to the private export`);
  return resolve(dir, name);
}

export async function loadProduct(product: AnyProductId, env: { [key: string]: string | undefined }): Promise<LoadedProduct> {
  let bytes: Buffer;
  try {
    bytes = await readFile(exportLocation(product, env));
  } catch {
    throw new IngestError("missing_input", `the private export for ${product} could not be read`);
  }
  return parseProduct(product, bytes);
}

export function parseProduct(product: AnyProductId, bytes: Buffer): LoadedProduct {
  const rows: VersionedExportRow[] = [];
  let line = 0;
  for (const text of bytes.toString("utf-8").split("\n")) {
    line++;
    if (!text.trim()) continue;
    try {
      const row = JSON.parse(text);
      if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error("not an object");
      rows.push(row);
    } catch {
      refuse(`export line ${line} is not a JSON object`);
    }
  }
  return { product, rows, digest: { sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, rows: rows.length } };
}

export interface PreflightFindings {
  product: AnyProductId;
  rows: number;
  records: number;
  waves: number;
  rows_by_kind: { [kind: string]: number };
  rows_with_publisher_date: number;
  manifest_agrees: boolean | null;
}

const SAFE_ID = /^[^\s<>"'\\]{1,400}$/;

/** Validates the whole file before any run exists. A refused file writes nothing and skips nothing. */
export function preflight(loaded: LoadedProduct, pin: ProductPin | undefined, manifest: ExportManifest | null): PreflightFindings {
  if (pin) {
    if (loaded.digest.sha256 !== pin.sha256) refuse(`${loaded.product}: input does not match the pinned checksum of the reconciled export`);
    if (loaded.digest.rows !== pin.rows) refuse(`${loaded.product}: input row count ${loaded.digest.rows} differs from the pinned ${pin.rows}`);
  }
  if (manifest) {
    const entry = manifest.files[loaded.product];
    if (!entry || entry.sha256 !== loaded.digest.sha256 || entry.rows !== loaded.digest.rows) refuse(`${loaded.product}: export manifest does not describe this file`);
    if (!manifest.all_checks_ok) refuse("export manifest records a failed reconciliation check");
  }
  if (loaded.rows.length === 0) refuse(`${loaded.product}: export held no rows; treated as a fault, not as an empty source`);

  const kinds: { [kind: string]: number } = {};
  const ordinals = new Map<string, number[]>();
  loaded.rows.forEach((row, index) => {
    const where = `${loaded.product} row ${index + 1}`;
    if (row.product_id !== loaded.product) refuse(`${where}: belongs to another product`);
    const id = row.external_record_id;
    if (typeof id !== "string" || !SAFE_ID.test(id) || /^[/~.]/.test(id) || id.includes("://") || id.includes("@")) refuse(`${where}: unusable record identifier`);
    if (typeof row.official_url !== "string" || !/^https:\/\/[A-Za-z0-9.-]+(\/|$)/.test(row.official_url) || /[?&#](key|api_?key|token|access_token|auth|sig|signature|secret|password|session)=/i.test(row.official_url)) {
      refuse(`${where}: no plain https official URL`);
    }
    if (typeof row.collected_at !== "string" || Number.isNaN(Date.parse(row.collected_at))) refuse(`${where}: no collection time`);
    // A publisher date is optional, but it may never simply repeat the collection time.
    if (row.source_published_at !== undefined) {
      if (Number.isNaN(Date.parse(row.source_published_at))) refuse(`${where}: unreadable publisher date`);
      if (row.source_published_at === row.collected_at) refuse(`${where}: publisher date equals the collection time`);
    }
    if (row.original_sha256 !== undefined && !/^[0-9a-f]{64}$/.test(row.original_sha256)) refuse(`${where}: malformed original hash`);
    if (row.source_published_at !== undefined && row.source_published_at > row.collected_at) refuse(`${where}: publisher date is later than the collection time`);
    // What makes a new version must be inside the payload, because the store hashes the payload alone.
    if ((row.payload?.original_document_digest ?? undefined) !== (row.original_sha256 ? letterHex(row.original_sha256) : undefined)) refuse(`${where}: original hash is not carried in the payload`);
    if ((row.payload?.publisher_stated_date ?? undefined) !== row.source_published_at) refuse(`${where}: publisher date is not carried in the payload`);
    if (!Array.isArray(row.omitted) || row.omitted.length > 100) refuse(`${where}: malformed omitted-field list`);
    const problem = contractProblem(row);
    if (problem) refuse(`${where}: ${problem}`);
    if (safeDigest(row) !== row.safe_digest) refuse(`${where}: content does not match its recorded digest`);
    kinds[row.record_kind] = (kinds[row.record_kind] ?? 0) + 1;
    ordinals.set(id, [...(ordinals.get(id) ?? []), row.version_ordinal]);
    if (!Number.isInteger(row.version_ordinal) || !Number.isInteger(row.version_count) || row.version_ordinal < 1 || row.version_ordinal > row.version_count) refuse(`${where}: bad version position`);
  });
  for (const [id, list] of ordinals) {
    const sorted = [...list].sort((a, b) => a - b);
    if (sorted.some((ordinal, index) => ordinal !== index + 1)) refuse(`${loaded.product}: a record's versions are not numbered 1..n exactly once`);
    const own = loaded.rows.filter((row) => row.external_record_id === id).sort((a, b) => a.version_ordinal - b.version_ordinal);
    if (own.some((row) => row.version_count !== own.length)) refuse(`${loaded.product}: a record's version count does not match its rows`);
    // Neighbouring versions must differ in what the store hashes, or the store would silently keep only the first.
    for (let i = 1; i < own.length; i++) {
      if (JSON.stringify(own[i].payload) === JSON.stringify(own[i - 1].payload)) refuse(`${loaded.product}: two neighbouring versions of a record have the same payload`);
    }
  }
  const waves = Math.max(...loaded.rows.map((row) => row.version_count));
  if (pin && (pin.records !== ordinals.size || pin.waves !== waves)) refuse(`${loaded.product}: record or wave count differs from the pin`);
  return {
    product: loaded.product, rows: loaded.rows.length, records: ordinals.size, waves, rows_by_kind: kinds,
    rows_with_publisher_date: loaded.rows.filter((row) => row.source_published_at).length, manifest_agrees: manifest ? true : null,
  };
}

/** Wave k of n. Every row lands in exactly one wave; a record's versions land in increasing waves. */
export function waveRows(rows: VersionedExportRow[], wave: number, waves: number): VersionedExportRow[] {
  return rows
    .filter((row) => (row.version_ordinal === row.version_count ? wave === waves : row.version_ordinal === wave))
    .sort((a, b) => a.external_record_id.localeCompare(b.external_record_id));
}

export function waveDigest(loaded: LoadedProduct, wave: number, waves: number, rows: number): { sha256: string; bytes: number; rows: number } {
  return { sha256: "sha256:" + createHash("sha256").update(`${loaded.digest.sha256}:wave:${wave}/${waves}`).digest("hex"), bytes: loaded.digest.bytes, rows };
}

export async function toIngestRecord(row: VersionedExportRow): Promise<IngestRecord> {
  const payload = row.payload as { [key: string]: Json };
  return {
    external_record_id: row.external_record_id,
    record_kind: row.record_kind,
    content_hash: await contentHash(row.record_kind, PROJECTION_VERSION, payload),
    original_content_hash: row.original_sha256 ? "sha256:" + row.original_sha256 : undefined,
    source_url: row.official_url,
    // Set only from a date the publisher stated. The collection time goes to retrieved_at and nowhere else.
    source_published_at: row.source_published_at,
    source_date_text: row.source_date_text,
    retrieved_at: row.collected_at,
    projection_version: PROJECTION_VERSION,
    safe_payload: payload,
    omitted_fields: row.omitted.map((o) => ({ field: o.field, reason: o.reason })),
  };
}

export function familyAdapter(rows: VersionedExportRow[], finalWave: boolean, watermark: string): Adapter {
  return {
    name: "election_family_export",
    version: FAMILY_ADAPTER_VERSION,
    async *pages(ctx: AdapterContext): AsyncGenerator<AdapterPage> {
      if (rows.length === 0) throw new IngestError("parse_error", "wave held no rows; treated as a fault, not as an empty source");
      const resume = ctx.resumeCursor as { next_row?: number } | null;
      // A checkpoint at the very end means the last run stored everything but never finished: start over (idempotent).
      const start = resume?.next_row && resume.next_row > 0 && resume.next_row < rows.length ? resume.next_row : 0;
      for (let offset = start; offset < rows.length; offset += PAGE_ROWS) {
        const slice = rows.slice(offset, offset + PAGE_ROWS);
        const records: IngestRecord[] = [];
        for (const row of slice) records.push(await toIngestRecord(row));
        const next = offset + slice.length;
        yield { records, cursor: { next_row: next }, done: next >= rows.length, completeSnapshot: finalWave && next >= rows.length && start === 0, watermark };
      }
    },
  };
}
