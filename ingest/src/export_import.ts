// Config-based import of a reviewed upstream export (JSON Lines).
//
// The export file lives outside the repository and is named only through an EVIDENCE_EXPORT_*
// environment variable. Nothing about its location, host or producer is written to the ledger:
// the manifest records the file's SHA-256, size and row count. Each row passes a per-source field
// allowlist; every other upstream field is dropped and the drop is recorded by name and reason.
// There is no blanket JSON or document-body import.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { contentHash } from "../../supabase/functions/_shared/canonical.ts";
import {
  type Adapter, type AdapterContext, type AdapterPage, type ExportContract, type FieldRule, IngestError,
  type IngestRecord, type Json, type OmittedField, type SourceConfig,
} from "../../supabase/functions/_shared/types.ts";

const PROJECTION_VERSION = 1;
const PAGE_ROWS = 400;

export interface LoadedExport {
  rows: { [key: string]: unknown }[];
  digest: { sha256: string; bytes: number; rows: number };
}

export async function loadExport(contract: ExportContract, env: { [key: string]: string | undefined }): Promise<LoadedExport> {
  const location = env[contract.fileEnv];
  if (!location) throw new IngestError("missing_input", `set ${contract.fileEnv} to the reviewed export file`);
  const bytes = await readFile(location);
  const rows: { [key: string]: unknown }[] = [];
  let lineNumber = 0;
  for (const line of bytes.toString("utf-8").split("\n")) {
    lineNumber++;
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error("not an object");
      rows.push(row);
    } catch {
      throw new IngestError("parse_error", `export line ${lineNumber} is not a JSON object`);
    }
  }
  return { rows, digest: { sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, rows: rows.length } };
}

function coerce(rule: FieldRule, value: unknown): Json | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  switch (rule.type) {
    case "string": {
      if (typeof value !== "string") return undefined;
      return value.trim().slice(0, rule.maxLength ?? 500) || undefined;
    }
    case "integer": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isSafeInteger(n) ? n : undefined;
    }
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "https_url":
      return typeof value === "string" && /^https:\/\/[^\s]+$/.test(value) ? value : undefined;
  }
}

export async function projectExportRow(
  source: SourceConfig, contract: ExportContract, row: { [key: string]: unknown }, fallbackRetrievedAt: string,
): Promise<IngestRecord> {
  const id = row[contract.idField];
  const sourceUrl = row[contract.sourceUrlField];
  if (typeof id !== "string" || !id) throw new IngestError("parse_error", `row lacks ${contract.idField}`);
  if (typeof sourceUrl !== "string" || !/^https:\/\//.test(sourceUrl)) throw new IngestError("parse_error", `row ${id} lacks an https ${contract.sourceUrlField}`);

  const payload: { [key: string]: Json } = {};
  const used = new Set<string>([contract.idField, contract.sourceUrlField, contract.observedAtField]);
  if (contract.originalHashField) used.add(contract.originalHashField);
  for (const rule of contract.allowedFields) {
    used.add(rule.from);
    const value = coerce(rule, row[rule.from]);
    if (value !== undefined) payload[rule.to] = value;
  }
  const omitted: OmittedField[] = [];
  const declared = new Map(contract.droppedFields.map((d) => [d.field, d.reason]));
  for (const key of Object.keys(row).sort()) {
    if (used.has(key)) continue;
    // Name and reason only. The dropped value is never read into the record.
    omitted.push({ field: key, reason: declared.get(key) ?? "not on this source's field allowlist" });
  }
  const observed = row[contract.observedAtField];
  const retrievedAt = typeof observed === "string" && !Number.isNaN(Date.parse(observed)) ? new Date(observed).toISOString() : fallbackRetrievedAt;
  const original = contract.originalHashField ? row[contract.originalHashField] : undefined;
  return {
    external_record_id: id.slice(0, 400),
    record_kind: contract.recordKind,
    content_hash: await contentHash(contract.recordKind, PROJECTION_VERSION, payload),
    original_content_hash: typeof original === "string" && original ? original.slice(0, 200) : undefined,
    source_url: sourceUrl,
    retrieved_at: retrievedAt,
    projection_version: PROJECTION_VERSION,
    safe_payload: payload,
    omitted_fields: omitted,
  };
  void source;
}

export function exportAdapter(loaded: LoadedExport): Adapter {
  return {
    name: "export_jsonl",
    version: "1.0.0",
    async *pages(ctx: AdapterContext): AsyncGenerator<AdapterPage> {
      const contract = ctx.source.export_contract;
      if (!contract) throw new IngestError("config_error", "source has no export_contract");
      const resume = ctx.resumeCursor as { next_row?: number } | null;
      const start = resume?.next_row && resume.next_row > 0 ? resume.next_row : 0;
      const fallback = ctx.now().toISOString();
      // Stable order so a resumed import continues exactly where the last one stopped.
      const ordered = [...loaded.rows].sort((a, b) => String(a[contract.idField]).localeCompare(String(b[contract.idField])));
      for (let offset = start; offset < ordered.length; offset += PAGE_ROWS) {
        const slice = ordered.slice(offset, offset + PAGE_ROWS);
        const records: IngestRecord[] = [];
        for (const row of slice) records.push(await projectExportRow(ctx.source, contract, row, fallback));
        const next = offset + slice.length;
        yield {
          records, cursor: { next_row: next }, done: next >= ordered.length,
          completeSnapshot: next >= ordered.length && start === 0, watermark: loaded.digest.sha256,
        };
      }
      if (ordered.length === 0) throw new IngestError("parse_error", "export held no rows; treated as a fault, not as an empty source");
    },
  };
}
