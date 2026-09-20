// Parliament family behind the loader contract. Real work is done by the family's own modules: verifyInput (pin, manifest,
// whole-file contract), importFamilyExport (history replayed in ordered generations) and the store's reconciliation readout.

import type { Json, SourcesFile } from "../../../../supabase/functions/_shared/types.ts";
import { contractFor, PARLIAMENT_EXPORT_CONTRACTS } from "../../families/parliament/contracts.ts";
import { exportLocations } from "../../families/parliament/exporter.ts";
import { FAMILY_EXPORT_ADAPTER, FAMILY_EXPORT_ADAPTER_VERSION, importFamilyExport, type ImportPlan, verifyInput } from "../../families/parliament/import.ts";
import { assertPrivateInput } from "../access.ts";
import { connectWorker } from "../connect.ts";
import { addWritten, check, type LoaderContext, type LoaderFamily, type LoaderUnit, newReceipt, settle, type TargetReceipt, writtenOf } from "../contract.ts";
import { refreshLedgerUnit } from "../ledger.ts";
import { addTypedTally } from "../typed.ts";
import { resolve } from "node:path";

/** Live sources this family owns, by export source. The core live sources (directory, current bills, feed) are core units. */
const REFRESH: { [sourceId: string]: string[] } = {
  parliament_export_releases_history: ["nz_government_releases_listing"],
  parliament_export_bill_publications: ["nz_parliament_bill_publications"],
  parliament_export_committee_business: ["nz_parliament_committee_business"],
  parliament_export_committee_reports: ["nz_parliament_committee_reports"],
  parliament_export_written_questions: ["nz_parliament_written_questions_recent"],
};
/** With --backfill the refresh of written questions walks the whole Parliament instead of the newest two months. */
const REFRESH_BACKFILL: { [sourceId: string]: string[] } = {
  parliament_export_written_questions: ["nz_parliament_written_questions_backfill"],
};

/** The typed table every distinct record of a kind must land in: one row each, whatever order the sources load in. */
export const TYPED_TABLE_OF_KIND: { [recordKind: string]: string } = {
  written_question: "written_questions", committee_report: "committee_reports", committee_report_file: "committee_report_files",
  committee_business_item: "committee_business_items", bill_publication: "bill_publications", bill_publication_set: "bill_publication_sets",
  bill: "bills", bill_register_entry: "bills", release: "releases", release_attribution: "release_attributions",
  member_service_term: "parliamentary_service_terms", minister_role: "role_terms",
};

/** With EVIDENCE_EXPORT_DIR set, the per-source variables default to the names the exporter writes. */
export function parliamentEnv(env: { [key: string]: string | undefined }): { [key: string]: string | undefined } {
  const out = { ...env };
  if (out.EVIDENCE_EXPORT_DIR) {
    for (const contract of PARLIAMENT_EXPORT_CONTRACTS) {
      const { file, manifest } = exportLocations(contract, resolve(out.EVIDENCE_EXPORT_DIR));
      out[contract.fileEnv] ??= file;
      out[contract.manifestEnv] ??= manifest;
    }
  }
  return out;
}

export function parliamentFamily(file: SourcesFile): LoaderFamily {
  const family: LoaderFamily = {
    family: "parliament",
    writer: "ledger_records_with_projection",
    units: () => PARLIAMENT_EXPORT_CONTRACTS.map((contract) => ({
      unit: contract.source_id, family: "parliament" as const, product_ids: contract.product_ids,
      backfill_source_ids: [contract.source_id], refresh_source_ids: REFRESH[contract.source_id] ?? [],
      alias_source_ids: REFRESH_BACKFILL[contract.source_id] ?? [],
    })),

    async plan(unit, ctx) { return inspect(unit, ctx, "plan"); },
    async validate(unit, ctx) { return inspect(unit, ctx, "validate"); },

    async import(unit, ctx, dryRun) {
      const receipt = newReceipt(family, unit, dryRun ? "dry-run" : "import", FAMILY_EXPORT_ADAPTER, FAMILY_EXPORT_ADAPTER_VERSION);
      const contract = contractFor(unit.unit);
      const env = parliamentEnv(ctx.env);
      await guardInput(contract.fileEnv, env, unit.unit);
      const source = file.sources.find((s) => s.source_id === contract.source_id)!;
      const connection = dryRun ? null : await connectWorker(ctx.env, "evidence-ingest-parliament");
      try {
        const result = await importFamilyExport({
          file, source, contract, env, db: connection?.db ?? null, dryRun, maxRuntimeSeconds: ctx.maxRuntimeSeconds,
          readDestination: connection ? async (sourceId) => (await connection.sql`select evidence_private.source_reconciliation(${sourceId}) as r`)[0].r as { [key: string]: Json } : undefined,
        });
        describePlan(receipt, result.input, result.plan);
        for (const generation of result.generations) {
          for (const attempt of generation.attempts) {
            receipt.provenance.manifest_hashes.push(attempt.manifest_hash);
            if (attempt.run_id) receipt.provenance.run_ids.push(attempt.run_id);
            if (attempt.resumed_from_run_id) receipt.provenance.resumed_from_run_ids.push(attempt.resumed_from_run_id);
          }
          if (dryRun) receipt.counts.destination.planned_ledger_records = (receipt.counts.destination.planned_ledger_records ?? 0) + generation.totals.seen;
          else addWritten(writtenOf(receipt, "ledger_records"), { seen: generation.totals.seen, inserted: generation.totals.versions_inserted, unchanged: generation.totals.unchanged, rejected: generation.totals.rejected, conflicts: 0, tombstoned: 0 });
        }
        for (const line of result.reconciliation) check(receipt, line.check, line.expected, line.actual);
        receipt.family_detail = result as unknown as Json;
        if (result.status === "failed" && result.reconciled === null) {
          const last = result.generations.at(-1)?.attempts.at(-1);
          receipt.status = last?.status === "partial" ? "partial" : last?.status === "skipped_lease_held" ? "skipped_lease_held" : "failed";
          receipt.error_code = last?.status === "partial" ? "budget_exhausted" : last?.status === "skipped_lease_held" ? "lease_held" : "run_failed";
          receipt.error_detail = last?.error_detail ?? null;
          return receipt;
        }
        if (connection) await addTyped(receipt, connection.sql, unit.unit, result.plan);
      } finally {
        await connection?.close();
      }
      return settle(receipt, dryRun ? "dry_run" : "succeeded");
    },

    refresh(unit, ctx, dryRun) {
      // The sources to run were chosen by the CLI (selectUnits) and arrive in unit.refresh_source_ids: a plain refresh, the
      // whole-Parliament walk (--backfill or its source id named), or exactly the source that was named. Nothing is
      // re-decided here, so a named source can never be exchanged for another.
      return refreshLedgerUnit(family, unit, file, ctx, dryRun);
    },

    async reconcile(unit, ctx) {
      const receipt = newReceipt(family, unit, "reconcile", FAMILY_EXPORT_ADAPTER, FAMILY_EXPORT_ADAPTER_VERSION);
      const contract = contractFor(unit.unit);
      const env = parliamentEnv(ctx.env);
      await guardInput(contract.fileEnv, env, unit.unit);
      const input = await verifyInput(contract, env);
      describePlan(receipt, input.pin, input.plan);
      const connection = await connectWorker(ctx.env, "evidence-ingest-parliament");
      try {
        const [{ r }] = await connection.sql`select evidence_private.source_reconciliation(${unit.unit}) as r`;
        const destination = r as { [key: string]: Json };
        const number = (key: string) => (typeof destination[key] === "number" ? (destination[key] as number) : null);
        check(receipt, "destination records = distinct publisher items in the export", input.plan.distinct_records, number("records"));
        check(receipt, "destination versions = distinct contents in the export", input.plan.distinct_versions, number("versions"));
        check(receipt, "destination records without a current version", 0, number("records_without_current_version"));
        check(receipt, "destination tombstones written by an import", 0, number("records_tombstoned"));
        check(receipt, "records rejected by the ledger guard", 0, number("rejected_records"));
        receipt.family_detail = { destination } as unknown as Json;
        await addTyped(receipt, connection.sql, unit.unit, input.plan);
      } finally {
        await connection.close();
      }
      return settle(receipt, "reconciled");
    },
  };

  async function guardInput(fileEnv: string, env: { [key: string]: string | undefined }, unit: string): Promise<void> {
    const location = env[fileEnv];
    if (location) await assertPrivateInput(location, `parliament export ${unit}`);
  }

  async function inspect(unit: LoaderUnit, ctx: LoaderContext, command: "plan" | "validate"): Promise<TargetReceipt> {
    const receipt = newReceipt(family, unit, command, FAMILY_EXPORT_ADAPTER, FAMILY_EXPORT_ADAPTER_VERSION);
    const contract = contractFor(unit.unit);
    const env = parliamentEnv(ctx.env);
    await guardInput(contract.fileEnv, env, unit.unit);
    // verifyInput re-hashes the file, checks it against the pin and its manifest, and builds every row once.
    const input = await verifyInput(contract, env);
    describePlan(receipt, input.pin, input.plan);
    const { lineGeneration: _line, ...plan } = input.plan;
    void _line;
    receipt.family_detail = { plan } as unknown as Json;
    if (command === "validate") check(receipt, "rows replayed + rows collapsed = rows in the export", plan.rows, plan.rows_per_generation.reduce((a, b) => a + b, 0) + plan.collapsed_rows);
    return command === "plan" ? { ...receipt, status: "planned" } : settle(receipt, "valid");
  }

  function describePlan(receipt: TargetReceipt, pin: { sha256: string; bytes: number; rows: number }, plan: Omit<ImportPlan, "lineGeneration">): void {
    receipt.provenance.input_digest = { sha256: pin.sha256, bytes: pin.bytes, rows: pin.rows };
    receipt.provenance.collected_from = plan.observed_min;
    receipt.provenance.collected_to = plan.observed_max;
    receipt.counts.input = { rows: plan.rows, records: plan.distinct_records, versions: plan.distinct_versions, by_population: { ledger_records: plan.distinct_records } };
  }

  /** Typed rows by proven lineage; each record kind of the export must have produced exactly one typed row per record. */
  async function addTyped(receipt: TargetReceipt, sql: Parameters<typeof addTypedTally>[1], sourceId: string, plan: Omit<ImportPlan, "lineGeneration">): Promise<void> {
    const typed = await addTypedTally(receipt, sql, sourceId);
    const expected: { [table: string]: number } = {};
    for (const [kind, records] of Object.entries(plan.records_by_kind)) {
      const table = TYPED_TABLE_OF_KIND[kind];
      if (table) expected[table] = (expected[table] ?? 0) + records;
    }
    for (const [table, rows] of Object.entries(expected)) check(receipt, `typed rows in ${table} = distinct records of that kind`, rows, typed[table] ?? 0);
  }

  return family;
}
