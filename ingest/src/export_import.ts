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

export interface ImportFindings {
  rows: number;
  rows_by_type: { [normalisedType: string]: number };
  /** Numbers the captured source passage does not show. They are omitted, never guessed. */
  unevidenced_numbers: { field: string; rows: number }[];
  /** Groups in which every evidenced value is zero. Reported as published; whether the contest was held is not inferred. */
  all_zero_groups: { field: string; group_field: string; group: string; rows: number }[];
  upstream_defaults_dropped: { field: string; rows: number }[];
}

/** Whole-number tokens in a captured passage, with or without thousands separators. */
export function numberTokens(passage: unknown): number[] {
  if (typeof passage !== "string") return [];
  return [...passage.matchAll(/(?<![\w.])\d{1,3}(?:,\d{3})+(?![\w.])|(?<![\w.,])\d+(?![\w.])/g)].map((m) => Number(m[0].replace(/,/g, "")));
}

function at(object: unknown, path: string[]): unknown {
  return path.reduce<unknown>((value, key) => (typeof value === "object" && value !== null ? (value as { [k: string]: unknown })[key] : undefined), object);
}

function refuse(message: string): never {
  throw new IngestError("input_not_accepted", message);
}

/**
 * Validates the WHOLE input before a run is started, so a bad file writes nothing and no row is ever
 * skipped: pinned checksum and count, upstream manifest agreement, required values, closed vocabularies,
 * unique identifiers. Messages never contain a file location or a row's content.
 */
export async function preflightExport(
  source: SourceConfig, contract: ExportContract, loaded: LoadedExport, env: { [key: string]: string | undefined },
): Promise<ImportFindings> {
  void source;
  if (contract.expectedInput) {
    if (loaded.digest.sha256 !== contract.expectedInput.sha256) refuse("input does not match the pinned checksum of the validated product");
    if (loaded.digest.rows !== contract.expectedInput.rows) refuse(`input row count ${loaded.digest.rows} differs from the pinned row count ${contract.expectedInput.rows}`);
  }
  if (contract.manifestEnv) {
    const location = env[contract.manifestEnv];
    if (!location) throw new IngestError("missing_input", `set ${contract.manifestEnv} to the upstream manifest of the export`);
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(location, "utf-8"));
    } catch {
      refuse("upstream manifest could not be read as JSON");
    }
    const checksum = at(manifest, contract.manifestChecksumPath ?? []);
    const count = at(manifest, contract.manifestRowsPath ?? []);
    if (typeof checksum !== "string" || "sha256:" + checksum.replace(/^sha256:/, "") !== loaded.digest.sha256) refuse("upstream manifest checksum does not match the input file");
    if (count !== loaded.digest.rows) refuse("upstream manifest row count does not match the input file");
  }

  const seen = new Set<string>();
  loaded.rows.forEach((row, index) => {
    const where = `row ${index + 1}`;
    const id = row[contract.idField];
    if (typeof id !== "string" || !id) refuse(`${where}: missing ${contract.idField}`);
    if (seen.has(id)) refuse(`${where}: duplicate ${contract.idField}`);
    seen.add(id);
    for (const required of contract.requiredValues ?? []) {
      if (row[required.field] !== required.equals) refuse(`${where}: ${required.field} is not the value this contract was written for`);
    }
    for (const map of contract.enumMaps ?? []) {
      const value = row[map.from];
      if (typeof value !== "string" || !Object.hasOwn(map.map, value)) refuse(`${where}: ${map.from} holds a value outside the documented upstream vocabulary`);
    }
  });

  const findings: ImportFindings = { rows: loaded.rows.length, rows_by_type: {}, unevidenced_numbers: [], all_zero_groups: [], upstream_defaults_dropped: [] };
  const typeMap = (contract.enumMaps ?? []).find((m) => m.to === "candidacy_type");
  for (const row of loaded.rows) {
    const type = typeMap ? typeMap.map[String(row[typeMap.from])] ?? "unknown" : "all";
    findings.rows_by_type[type] = (findings.rows_by_type[type] ?? 0) + 1;
  }
  for (const rule of contract.evidencedNumbers ?? []) {
    let unevidenced = 0;
    let defaults = 0;
    const groups = new Map<string, { rows: number; zeros: number }>();
    for (const row of loaded.rows) {
      const outcome = evidencedNumber(contract, rule, row);
      if (outcome.kind === "not_applicable") defaults++;
      else if (outcome.kind === "unevidenced") unevidenced++;
      else if (rule.allZeroGroupField) {
        const group = String(row[rule.allZeroGroupField] ?? "");
        const entry = groups.get(group) ?? { rows: 0, zeros: 0 };
        entry.rows++;
        if (outcome.value === 0) entry.zeros++;
        groups.set(group, entry);
      }
    }
    if (unevidenced) findings.unevidenced_numbers.push({ field: rule.to, rows: unevidenced });
    if (defaults) findings.upstream_defaults_dropped.push({ field: rule.to, rows: defaults });
    for (const [group, entry] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      if (entry.rows > 0 && entry.zeros === entry.rows) findings.all_zero_groups.push({ field: rule.to, group_field: rule.allZeroGroupField!, group, rows: entry.rows });
    }
  }
  return findings;
}

type NumberOutcome = { kind: "evidenced"; value: number } | { kind: "unevidenced" } | { kind: "not_applicable" };

/** A number is kept only if it applies to this kind of row AND the captured source passage shows it. Zero included. */
function evidencedNumber(contract: ExportContract, rule: NonNullable<ExportContract["evidencedNumbers"]>[number], row: { [key: string]: unknown }): NumberOutcome {
  const gate = (contract.enumMaps ?? []).find((m) => m.to === rule.onlyWhen.field);
  const gateValue = gate ? gate.map[String(row[gate.from])] : row[rule.onlyWhen.field];
  if (gateValue !== rule.onlyWhen.equals) return { kind: "not_applicable" };
  const raw = row[rule.from];
  const value = typeof raw === "number" ? raw : Number(raw);
  if (raw === null || raw === undefined || raw === "" || !Number.isSafeInteger(value) || value < 0) return { kind: "unevidenced" };
  return numberTokens(row[rule.passageField]).includes(value) ? { kind: "evidenced", value } : { kind: "unevidenced" };
}

const PLAIN_FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;

/** Upstream column names are published in omitted_fields, so a hostile one is reduced to a digest. */
export function safeFieldName(name: string): string {
  if (PLAIN_FIELD.test(name) && !/mail|phone|passw|secret|token/i.test(name)) return name;
  return "unlisted_field_" + createHash("sha256").update(name).digest("hex").slice(0, 12);
}

const SAFE_ID = /^[^\s<>"'\\]{1,400}$/;

export async function projectExportRow(
  source: SourceConfig, contract: ExportContract, row: { [key: string]: unknown }, fallbackRetrievedAt: string,
): Promise<IngestRecord> {
  const id = row[contract.idField];
  const sourceUrl = row[contract.sourceUrlField];
  if (typeof id !== "string" || !id) throw new IngestError("parse_error", `row lacks ${contract.idField}`);
  // The identifier is never echoed into an error: it is untrusted and errors are logged.
  if (!SAFE_ID.test(id) || /^[/~.]/.test(id) || id.includes("://") || id.includes("@")) {
    throw new IngestError("parse_error", `row has an unusable ${contract.idField} (digest ${createHash("sha256").update(id).digest("hex").slice(0, 12)})`);
  }
  if (typeof sourceUrl !== "string" || !/^https:\/\/[A-Za-z0-9.-]+(\/|$)/.test(sourceUrl) || /[?&#](key|api_?key|token|access_token|auth|sig|signature|secret|password|session)=/i.test(sourceUrl)) {
    throw new IngestError("parse_error", `row lacks a plain https ${contract.sourceUrlField}`);
  }

  const payload: { [key: string]: Json } = {};
  const used = new Set<string>([contract.idField, contract.sourceUrlField, contract.observedAtField]);
  if (contract.originalHashField) used.add(contract.originalHashField);
  for (const rule of contract.allowedFields) {
    used.add(rule.from);
    const value = coerce(rule, row[rule.from]);
    if (value !== undefined) payload[rule.to] = value;
  }
  const omitted: OmittedField[] = [];
  for (const map of contract.enumMaps ?? []) {
    used.add(map.from);
    const value = row[map.from];
    // Preflight has already refused unknown values for the whole file; this guards direct callers.
    if (typeof value !== "string" || !Object.hasOwn(map.map, value)) throw new IngestError("input_not_accepted", `${map.from} holds a value outside the documented upstream vocabulary`);
    if (map.map[value] !== "") payload[map.to] = map.map[value] as string;
    if (map.keepUpstreamAs) payload[map.keepUpstreamAs] = value;
  }
  for (const rule of contract.evidencedNumbers ?? []) {
    used.add(rule.from);
    const outcome = evidencedNumber(contract, rule, row);
    if (outcome.kind === "evidenced") {
      payload[rule.to] = outcome.value;
      payload[rule.to + "_evidence"] = "number_found_in_captured_source_passage";
    } else {
      omitted.push({ field: rule.from, reason: outcome.kind === "not_applicable" ? rule.notApplicableReason : "not evidenced by the captured source passage; omitted rather than guessed, in either direction" });
    }
  }
  const declared = new Map(contract.droppedFields.map((d) => [d.field, d.reason]));
  for (const key of Object.keys(row).sort()) {
    if (used.has(key)) continue;
    // Name and reason only. The dropped value is never read into the record, and an upstream column
    // name is itself untrusted input: anything that is not a plain identifier is replaced by a digest.
    omitted.push({ field: safeFieldName(key), reason: declared.get(key) ?? "not on this source's field allowlist" });
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
