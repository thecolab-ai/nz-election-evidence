// The one loader contract. Every import family is reached through it, from one CLI (ingest/src/cli.ts):
//
//   plan       what would be read and written, from the registry and the private inputs. No database, no network.
//   validate   the private inputs are re-hashed and checked, row by row, against their pins and closed contracts.
//   dry-run    the whole import path short of a write: preflight, generations or waves, batches; no database.
//   import     the backfill route: private artifact -> store. Replay-safe, checkpointed, resumable.
//   refresh    the current-refresh route: a fresh anonymous fetch -> store. A blocked route answers "blocked"; it is
//              never contacted a second time and never reported as "no records".
//   reconcile  read-only: what the store holds against what the private inputs say it should hold.
//
// What is shared lives here and in the modules beside this file: the manifest and provenance block, run statuses,
// error codes, leases, checkpoints and retries (all through the versioned evidence_private functions), count receipts,
// and the privacy and source-access rules. What is NOT shared, on purpose: each family keeps its own typed
// destination and writer. The ledger families write allowlisted records through ingest_batch and a registered
// projector; statistics writes typed rows in bulk through ingest_stat_meta / ingest_stat_observations. Nothing is
// flattened into a generic JSON shape to make the families look alike.

import type { Json } from "../../../supabase/functions/_shared/types.ts";

export const LOADER_CONTRACT_VERSION = 2;

export const LOADER_COMMANDS = ["plan", "validate", "dry-run", "import", "refresh", "reconcile"] as const;
export type LoaderCommand = (typeof LOADER_COMMANDS)[number];

export type FamilyId = "core" | "election" | "parliament" | "statistics";

/** How a family writes. Stated so nobody mistakes the shared orchestration for a shared destination. */
export type WriterKind = "ledger_records_with_projection" | "typed_statistics_bulk_writer";

/** One status vocabulary for every family. */
export type LoaderStatus =
  | "planned"            // plan: nothing was opened beyond reading inputs
  | "valid"              // validate: every input matched its pin and contract
  | "dry_run"            // dry-run: the import path ran with no database
  | "succeeded"          // import / refresh: finished, and every count check passed
  | "reconciled"         // reconcile: every check passed
  | "partial"            // stopped at a budget with a checkpoint; the next call resumes
  | "blocked"            // the route is unavailable (publisher challenge, pending decision, no route); nothing was written
  | "skipped_lease_held" // another worker holds the source
  | "refused_input"      // a private input failed its pin, mode or contract; nothing was written
  | "not_reconciled"     // finished, but a count check failed
  | "failed";

/** Closed list. A receipt never carries a free-form class. */
export const ERROR_CODES = [
  "usage", "config_invalid", "target_unknown",
  "input_missing", "input_location_not_private", "input_pin_mismatch", "input_contract_violation",
  "route_none", "route_blocked", "route_pending_decision",
  "db_url_missing", "elevated_login_refused", "lease_held",
  "ledger_rejected_rows", "value_conflict", "run_failed", "budget_exhausted", "not_reconciled", "transient_database", "unexpected",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Process exit codes, one meaning each. */
export const EXIT = { ok: 0, usage_or_config: 1, run_failed: 2, input_refused: 3, not_reconciled: 4, blocked: 5 } as const;

export function exitCodeFor(status: LoaderStatus): number {
  switch (status) {
    case "planned": case "valid": case "dry_run": case "succeeded": case "reconciled": return EXIT.ok;
    case "refused_input": return EXIT.input_refused;
    case "not_reconciled": return EXIT.not_reconciled;
    case "blocked": return EXIT.blocked;
    default: return EXIT.run_failed;
  }
}

export class LoaderError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "LoaderError";
    this.code = code;
  }
}

/** The code that produced a receipt: the commit of the checkout it ran from, and whether that checkout had uncommitted changes. */
export interface SourceRevision { commit: string | null; dirty: boolean | null }

/** Where the input came from and what exactly it was. Digests and counts; never a location on a disk. */
export interface Provenance {
  adapter_name: string;
  adapter_version: string;
  /** Pinned by the CLI on every receipt. A receipt of a dirty or unknown checkout is not evidence about any commit. */
  source_revision: SourceRevision;
  /** Hash and size of the private input as verified before the run. Null for a refresh (the fetch log carries body hashes). */
  input_digest: { sha256: string; bytes: number | null; rows: number | null } | null;
  /** Deterministic run manifests (no timestamps), one per ledger run started. */
  manifest_hashes: string[];
  run_ids: string[];
  resumed_from_run_ids: string[];
  /** Collection window the input states. Collection times are never publisher dates. */
  collected_from: string | null;
  collected_to: string | null;
}

export interface CountCheck {
  name: string;
  expected: number | string;
  actual: number | string | null;
  ok: boolean;
}

/**
 * A population is ONE kind of row. Counters of different populations are never added together: a ledger record, a
 * statistical observation and a catalogue entry version are different things, and a sum of them means nothing.
 */
export const POPULATIONS = ["ledger_records", "stat_observations", "stat_catalogue_entries"] as const;
export type Population = (typeof POPULATIONS)[number];

/**
 * What one write command did to one population. `seen` rows were offered to the store; each of them was inserted (a new
 * version or row), left unchanged, rejected or found in conflict: inserted + unchanged + rejected + conflicts = seen.
 * `tombstoned` counts records that were NOT seen (a complete snapshot no longer lists them); it is outside that sum.
 */
export interface WrittenCounts { seen: number; inserted: number; unchanged: number; rejected: number; conflicts: number; tombstoned: number }

/** The shared count receipt: input -> store -> typed destination, per population, with every check named. */
export interface CountReceipt {
  input: { rows: number | null; records: number | null; versions: number | null; by_population: { [population in Population]?: number } };
  /** One block per population the unit holds. A unit of catalogue metadata only has no observation block at all. */
  written: { [population in Population]?: WrittenCounts };
  /** Typed destination rows by table or measure, as read back from the store. Empty when no database was used. */
  destination: { [name: string]: number };
  checks: CountCheck[];
}

export function zeroWritten(): WrittenCounts {
  return { seen: 0, inserted: 0, unchanged: 0, rejected: 0, conflicts: 0, tombstoned: 0 };
}

/** The block of one population, created on first use. */
export function writtenOf(receipt: { counts: CountReceipt }, population: Population): WrittenCounts {
  return (receipt.counts.written[population] ??= zeroWritten());
}

/** Every way a block of counters can be wrong. Empty when the invariants hold. */
export function writtenProblems(population: string, w: WrittenCounts): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(w)) if (!Number.isInteger(value) || value < 0) problems.push(`${population}: ${name} is not a whole number >= 0`);
  if (w.inserted > w.seen) problems.push(`${population}: inserted (${w.inserted}) > seen (${w.seen})`);
  if (w.inserted + w.unchanged + w.rejected + w.conflicts !== w.seen) problems.push(`${population}: inserted + unchanged + rejected + conflicts (${w.inserted + w.unchanged + w.rejected + w.conflicts}) <> seen (${w.seen})`);
  return problems;
}

/** Adds blocks of the SAME population. There is no function that adds across populations, on purpose. */
export function addWritten(into: WrittenCounts, from: WrittenCounts): WrittenCounts {
  for (const name of Object.keys(into) as (keyof WrittenCounts)[]) into[name] += from[name];
  return into;
}

export interface TargetReceipt {
  receipt_version: 3;
  contract_version: typeof LOADER_CONTRACT_VERSION;
  command: LoaderCommand;
  family: FamilyId;
  writer: WriterKind;
  /** The family's unit of work: a source id, or for the election family a product id. */
  unit: string;
  source_ids: string[];
  product_ids: string[];
  status: LoaderStatus;
  error_code: ErrorCode | null;
  error_detail: string | null;
  attempts: number;
  provenance: Provenance;
  counts: CountReceipt;
  /** The family's own receipt, kept whole. Counts, digests, statuses and publisher links only. */
  family_detail: Json;
}

export interface LoaderContext {
  env: { [key: string]: string | undefined };
  log: (message: string) => void;
  /** refresh only: walk the publisher's whole list rather than the recent window. */
  backfill?: boolean;
  maxRecords?: number;
  maxRuntimeSeconds?: number;
  /** Test hooks, never set by the CLI. */
  failAfterBatches?: number;
}

/** A unit a family can act on, with the routes it really has. */
export interface LoaderUnit {
  unit: string;
  family: FamilyId;
  product_ids: string[];
  /** Sources written by the backfill route. Empty when the unit has no backfill route. */
  backfill_source_ids: string[];
  /** Live sources of the refresh route, in the order they would run. Empty when there is none. */
  refresh_source_ids: string[];
  /** Further source ids that name this unit as a target without being part of a plain refresh (a deliberate backfill walk). */
  alias_source_ids?: string[];
}

/** The adapter a family implements. Real work is delegated to the family's own modules; nothing is re-implemented. */
export interface LoaderFamily {
  family: FamilyId;
  writer: WriterKind;
  units(): LoaderUnit[];
  plan(unit: LoaderUnit, ctx: LoaderContext): Promise<TargetReceipt>;
  validate(unit: LoaderUnit, ctx: LoaderContext): Promise<TargetReceipt>;
  /** dryRun = true never opens a database connection. */
  import(unit: LoaderUnit, ctx: LoaderContext, dryRun: boolean): Promise<TargetReceipt>;
  refresh(unit: LoaderUnit, ctx: LoaderContext, dryRun: boolean): Promise<TargetReceipt>;
  reconcile(unit: LoaderUnit, ctx: LoaderContext): Promise<TargetReceipt>;
}

export function emptyCounts(): CountReceipt {
  return { input: { rows: null, records: null, versions: null, by_population: {} }, written: {}, destination: {}, checks: [] };
}

export function emptyProvenance(adapterName: string, adapterVersion: string): Provenance {
  return { adapter_name: adapterName, adapter_version: adapterVersion, source_revision: { commit: null, dirty: null }, input_digest: null, manifest_hashes: [], run_ids: [], resumed_from_run_ids: [], collected_from: null, collected_to: null };
}

export function newReceipt(family: LoaderFamily, unit: LoaderUnit, command: LoaderCommand, adapterName: string, adapterVersion: string): TargetReceipt {
  const sourceIds = command === "refresh" ? unit.refresh_source_ids : [...new Set([...unit.backfill_source_ids, ...(command === "plan" ? unit.refresh_source_ids : [])])];
  return {
    receipt_version: 3, contract_version: LOADER_CONTRACT_VERSION, command, family: family.family, writer: family.writer, unit: unit.unit,
    source_ids: sourceIds, product_ids: unit.product_ids, status: "failed", error_code: null, error_detail: null, attempts: 1,
    provenance: emptyProvenance(adapterName, adapterVersion), counts: emptyCounts(), family_detail: null,
  };
}

export function check(receipt: TargetReceipt, name: string, expected: number | string, actual: number | string | null): void {
  receipt.counts.checks.push({ name, expected, actual, ok: actual !== null && actual === expected });
}

/** A finished write command succeeded only if every named check passed, the counters obey their invariants and nothing was rejected or in conflict. */
export function settle(receipt: TargetReceipt, okStatus: LoaderStatus): TargetReceipt {
  const blocks = Object.entries(receipt.counts.written) as [Population, WrittenCounts][];
  const broken = blocks.flatMap(([population, w]) => writtenProblems(population, w));
  // Only a finished command is held to the sum: a run that stopped part-way never reaches settle.
  check(receipt, "count invariants: per population, inserted + unchanged + rejected + conflicts = seen", "hold", broken.length === 0 ? "hold" : broken.slice(0, 3).join("; "));
  if (blocks.some(([, w]) => w.rejected > 0)) {
    receipt.status = "not_reconciled";
    receipt.error_code = "ledger_rejected_rows";
  } else if (blocks.some(([, w]) => w.conflicts > 0)) {
    receipt.status = "not_reconciled";
    receipt.error_code = "value_conflict";
  } else if (receipt.counts.checks.some((c) => !c.ok)) {
    receipt.status = "not_reconciled";
    receipt.error_code = "not_reconciled";
    receipt.error_detail = receipt.counts.checks.filter((c) => !c.ok).map((c) => c.name).slice(0, 5).join("; ");
  } else {
    receipt.status = okStatus;
  }
  return receipt;
}
