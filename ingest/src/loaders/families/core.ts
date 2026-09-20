// Core sources behind the loader contract: the sources that were in the registry before the three families (the three
// working live sources, the Electoral Commission availability probes, and the pinned 2023 candidacy export, P04).

import { LIVE_ADAPTERS } from "../../../../supabase/functions/_shared/adapters/index.ts";
import { buildManifest } from "../../../../supabase/functions/_shared/registry.ts";
import { runSource } from "../../../../supabase/functions/_shared/runner.ts";
import type { Json, SourceConfig, SourcesFile } from "../../../../supabase/functions/_shared/types.ts";
import { exportAdapter, loadExport, preflightExport } from "../../export_import.ts";
import { assertPrivateInput, type PrivateInputFinding } from "../access.ts";
import { connectWorker } from "../connect.ts";
import { check, type LoaderContext, type LoaderFamily, type LoaderUnit, newReceipt, settle, type TargetReceipt } from "../contract.ts";
import { addReport, refreshLedgerUnit, reportDetail } from "../ledger.ts";
import { sourceFamilies } from "../registry.ts";
import { addTypedTally } from "../typed.ts";

/** Typed rows each record of a core export must have produced. */
const TYPED_TABLE: { [sourceId: string]: string } = { baseline_2023_candidacies_export: "candidacies" };

export function coreFamily(file: SourcesFile): LoaderFamily {
  const owned = sourceFamilies();
  const coreSources = file.sources.filter((s) => !owned.has(s.source_id));
  const sourceOf = (unit: LoaderUnit): SourceConfig => coreSources.find((s) => s.source_id === unit.unit)!;

  const family: LoaderFamily = {
    family: "core",
    writer: "ledger_records_with_projection",
    units: () => coreSources.map((source) => ({
      unit: source.source_id, family: "core" as const, product_ids: (source.catalogue_products ?? []).map((p) => p.product_id),
      backfill_source_ids: source.adapter_kind === "export_import" ? [source.source_id] : [],
      refresh_source_ids: source.adapter_kind === "live_fetch" ? [source.source_id] : [],
    })),

    async plan(unit, ctx) { return inspect(unit, ctx, "plan"); },
    async validate(unit, ctx) { return inspect(unit, ctx, "validate"); },

    async import(unit, ctx, dryRun) {
      const source = sourceOf(unit);
      const receipt = newReceipt(family, unit, dryRun ? "dry-run" : "import", source.adapter_name, "1.0.0");
      if (source.adapter_kind !== "export_import" || !source.export_contract) return noBackfill(receipt);
      const findings = await guard(source, ctx);
      const loaded = await loadExport(source.export_contract, ctx.env);
      // The whole file is validated before a run exists: a rejected input writes nothing and skips nothing.
      const inputFindings = await preflightExport(source, source.export_contract, loaded, ctx.env);
      receipt.provenance.input_digest = loaded.digest;
      receipt.counts.input = { rows: loaded.digest.rows, records: loaded.digest.rows, versions: loaded.digest.rows };
      const connection = dryRun ? null : await connectWorker(ctx.env);
      try {
        const report = await runSource({
          file, source, adapter: exportAdapter(loaded), mode: "export_import", triggerKind: "cli", maxRecords: ctx.maxRecords ?? 200000,
          maxRuntimeSeconds: ctx.maxRuntimeSeconds ?? 3300, dryRun, db: connection?.db ?? null, inputDigest: loaded.digest, failAfterBatches: ctx.failAfterBatches,
        });
        addReport(receipt, report);
        receipt.family_detail = { private_input_findings: findings, input_findings: inputFindings, run: reportDetail(report) } as unknown as Json;
        if (report.status !== "succeeded" && report.status !== "dry_run") {
          receipt.status = report.status === "partial" ? "partial" : report.status === "skipped_lease_held" ? "skipped_lease_held" : "failed";
          receipt.error_code = report.status === "partial" ? "budget_exhausted" : report.status === "skipped_lease_held" ? "lease_held" : "run_failed";
          receipt.error_detail = report.error_detail;
          return receipt;
        }
        if (connection) await reconcileExport(receipt, connection.sql, source, loaded.digest.rows);
      } finally {
        await connection?.close();
      }
      return settle(receipt, dryRun ? "dry_run" : "succeeded");
    },

    refresh: (unit, ctx, dryRun) => refreshLedgerUnit(family, unit, file, ctx, dryRun),

    async reconcile(unit, ctx) {
      const source = sourceOf(unit);
      const receipt = newReceipt(family, unit, "reconcile", source.adapter_name, "1.0.0");
      const connection = await connectWorker(ctx.env);
      try {
        if (source.adapter_kind === "export_import" && source.export_contract) {
          await guard(source, ctx);
          const loaded = await loadExport(source.export_contract, ctx.env);
          await preflightExport(source, source.export_contract, loaded, ctx.env);
          receipt.provenance.input_digest = loaded.digest;
          receipt.counts.input = { rows: loaded.digest.rows, records: loaded.digest.rows, versions: null };
          await reconcileExport(receipt, connection.sql, source, loaded.digest.rows);
        } else {
          // A live source has no fixed expectation: the publisher's list moves. What must always hold is checked.
          const [{ r }] = await connection.sql`select evidence_private.source_reconciliation(${source.source_id}) as r`;
          const destination = r as { [key: string]: Json };
          check(receipt, "destination records without a current version", 0, typeof destination.records_without_current_version === "number" ? destination.records_without_current_version : null);
          await addTypedTally(receipt, connection.sql, source.source_id);
          receipt.family_detail = { destination } as unknown as Json;
        }
      } finally {
        await connection.close();
      }
      return settle(receipt, "reconciled");
    },
  };

  function noBackfill(receipt: TargetReceipt): TargetReceipt {
    receipt.status = "blocked";
    receipt.error_code = "route_none";
    receipt.error_detail = "a live source has no backfill artifact; its route is `refresh`";
    return receipt;
  }

  async function guard(source: SourceConfig, ctx: LoaderContext): Promise<PrivateInputFinding[]> {
    const location = source.export_contract ? ctx.env[source.export_contract.fileEnv] : undefined;
    // This capture predates the 0600 rule for family artifacts: its mode is reported, its place outside the repository is required.
    return location ? assertPrivateInput(location, `export ${source.source_id}`, "advise") : [];
  }

  async function inspect(unit: LoaderUnit, ctx: LoaderContext, command: "plan" | "validate"): Promise<TargetReceipt> {
    const source = sourceOf(unit);
    const receipt = newReceipt(family, unit, command, source.adapter_name, LIVE_ADAPTERS[source.adapter_name]?.version ?? "1.0.0");
    if (source.adapter_kind === "export_import" && source.export_contract) {
      const findings = await guard(source, ctx);
      const loaded = await loadExport(source.export_contract, ctx.env);
      const inputFindings = await preflightExport(source, source.export_contract, loaded, ctx.env);
      receipt.provenance.input_digest = loaded.digest;
      receipt.counts.input = { rows: loaded.digest.rows, records: loaded.digest.rows, versions: loaded.digest.rows };
      receipt.family_detail = { private_input_findings: findings, input_findings: inputFindings } as unknown as Json;
    } else {
      const { manifest, manifestHash } = await buildManifest(file, source, receipt.provenance.adapter_version, ctx.backfill ? "backfill" : "incremental", ctx.maxRecords ?? 2000);
      receipt.provenance.manifest_hashes.push(manifestHash);
      receipt.family_detail = { manifest, enabled: source.enabled, blocked_reason: source.blocked_reason ?? null } as unknown as Json;
    }
    receipt.status = command === "plan" ? "planned" : "valid";
    return receipt;
  }

  async function reconcileExport(receipt: TargetReceipt, sql: Parameters<typeof addTypedTally>[1], source: SourceConfig, rows: number): Promise<void> {
    const [{ r }] = await sql`select evidence_private.source_reconciliation(${source.source_id}) as r`;
    const destination = r as { [key: string]: Json };
    const number = (key: string) => (typeof destination[key] === "number" ? (destination[key] as number) : null);
    check(receipt, "destination records = rows in the pinned export", rows, number("records"));
    check(receipt, "destination records without a current version", 0, number("records_without_current_version"));
    check(receipt, "destination tombstones", 0, number("records_tombstoned"));
    const typed = await addTypedTally(receipt, sql, source.source_id);
    const table = TYPED_TABLE[source.source_id];
    if (table) check(receipt, `typed rows in ${table} = rows in the pinned export`, rows, typed[table] ?? 0);
  }

  return family;
}
