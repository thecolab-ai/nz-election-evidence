// Election family behind the loader contract. Real work is done by the family's own modules (operations.ts, adapter.ts,
// reconcile.ts): per-kind closed contracts, history replayed in waves, identifier joins to the 2023 candidacy product.

import type { SourcesFile } from "../../../../supabase/functions/_shared/types.ts";
import { exportLocation, FAMILY_ADAPTER_VERSION } from "../../families/election/adapter.ts";
import type { AnyProductId } from "../../families/election/exporter.ts";
import { ELECTION_PRODUCTS, exportSourceOf, importProducts, planProducts, reconcileProducts, runSummary } from "../../families/election/operations.ts";
import { assertPrivateInput } from "../access.ts";
import { connectWorker } from "../connect.ts";
import { check, type LoaderContext, type LoaderFamily, type LoaderUnit, newReceipt, settle, type TargetReceipt } from "../contract.ts";
import { addReport, refreshLedgerUnit } from "../ledger.ts";
import { addTypedTally } from "../typed.ts";
import type { Json } from "../../../../supabase/functions/_shared/types.ts";

/** Refresh sources this family owns, by product. Probes of Electoral Commission pages owned by the core registry are core units. */
const REFRESH: { [product: string]: string[] } = {
  P13: ["party_policy_pages_2026_monitor"],
  P14: ["party_vote_polls_index"],
  P15: ["ec_2023_candidate_returns_index"],
  C26B: ["ec_2026_electorate_finder"],
};

const CATALOGUE_PRODUCT = /^P\d\d$/;

export function electionFamily(file: SourcesFile): LoaderFamily {
  const family: LoaderFamily = {
    family: "election",
    writer: "ledger_records_with_projection",
    units: () => ELECTION_PRODUCTS.map((product) => ({
      unit: product, family: "election" as const, product_ids: CATALOGUE_PRODUCT.test(product) ? [product] : [],
      backfill_source_ids: [exportSourceOf(product).source_id], refresh_source_ids: REFRESH[product] ?? [],
    })),

    async plan(unit, ctx) { return inspect(unit, ctx, "plan"); },
    async validate(unit, ctx) { return inspect(unit, ctx, "validate"); },

    async import(unit, ctx, dryRun) {
      const receipt = newReceipt(family, unit, dryRun ? "dry-run" : "import", "election_family_export", FAMILY_ADAPTER_VERSION);
      const product = unit.unit as AnyProductId;
      await assertPrivateInput(exportLocation(product, ctx.env), `election export ${product}`);
      const { planned } = await planProducts([product], ctx.env);
      describeInput(receipt, planned[0]);
      const connection = dryRun ? null : await connectWorker(ctx.env, "evidence-ingest-election");
      try {
        const { runs, failed } = await importProducts(planned, { file, dryRun, connection, failAfterBatches: ctx.failAfterBatches });
        for (const run of runs) if (run.report) addReport(receipt, run.report);
        receipt.family_detail = runs.map((r) => (r.report ? { wave: r.wave, waves: r.waves, ...runSummary(r.report) } : { wave: r.wave, waves: r.waves, status: "history_already_stored", rows_skipped: r.skipped_rows ?? 0 })) as unknown as Json;
        if (failed) {
          const last = runs.findLast((r) => r.report)?.report;
          receipt.status = last?.status === "partial" ? "partial" : last?.status === "skipped_lease_held" ? "skipped_lease_held" : "failed";
          receipt.error_code = last?.status === "partial" ? "budget_exhausted" : last?.status === "skipped_lease_held" ? "lease_held" : (last?.totals.rejected ?? 0) > 0 ? "ledger_rejected_rows" : "run_failed";
          receipt.error_detail = last?.error_detail ?? null;
          return receipt;
        }
        if (connection) await addReconciliation(receipt, connection.sql, ctx, product);
      } finally {
        await connection?.close();
      }
      return settle(receipt, dryRun ? "dry_run" : "succeeded");
    },

    refresh: (unit, ctx, dryRun) => refreshLedgerUnit(family, unit, file, ctx, dryRun),

    async reconcile(unit, ctx) {
      const receipt = newReceipt(family, unit, "reconcile", "election_family_export", FAMILY_ADAPTER_VERSION);
      const product = unit.unit as AnyProductId;
      await assertPrivateInput(exportLocation(product, ctx.env), `election export ${product}`);
      const { planned } = await planProducts([product], ctx.env);
      describeInput(receipt, planned[0]);
      const connection = await connectWorker(ctx.env, "evidence-ingest-election");
      try {
        await addReconciliation(receipt, connection.sql, ctx, product);
      } finally {
        await connection.close();
      }
      return settle(receipt, "reconciled");
    },
  };

  async function inspect(unit: LoaderUnit, ctx: LoaderContext, command: "plan" | "validate"): Promise<TargetReceipt> {
    const receipt = newReceipt(family, unit, command, "election_family_export", FAMILY_ADAPTER_VERSION);
    const product = unit.unit as AnyProductId;
    await assertPrivateInput(exportLocation(product, ctx.env), `election export ${product}`);
    // preflight checks the pin (checksum, rows, records, waves), the export manifest and every row's closed contract.
    const { manifest_present, planned } = await planProducts([product], ctx.env);
    describeInput(receipt, planned[0]);
    receipt.family_detail = { export_manifest_present: manifest_present, plan: planned[0].plan } as unknown as Json;
    receipt.status = command === "plan" ? "planned" : "valid";
    return receipt;
  }

  function describeInput(receipt: TargetReceipt, planned: Awaited<ReturnType<typeof planProducts>>["planned"][number]): void {
    receipt.provenance.input_digest = planned.loaded.digest;
    receipt.counts.input = { rows: planned.findings.rows, records: planned.findings.records, versions: planned.findings.rows };
    const times = planned.loaded.rows.map((r) => r.collected_at).filter((t): t is string => typeof t === "string").sort();
    receipt.provenance.collected_from = times[0] ?? null;
    receipt.provenance.collected_to = times.at(-1) ?? null;
  }

  async function addReconciliation(receipt: TargetReceipt, sql: Parameters<typeof reconcileProducts>[0], ctx: LoaderContext, product: AnyProductId): Promise<void> {
    const { lines, cross_route } = await reconcileProducts(sql, ctx.env, [product]);
    for (const line of lines) for (const c of line.checks) check(receipt, c.name, c.expected, c.actual);
    await addTypedTally(receipt, sql, exportSourceOf(product).source_id);
    receipt.family_detail = { runs: receipt.family_detail, cross_route } as unknown as Json;
  }

  return family;
}
