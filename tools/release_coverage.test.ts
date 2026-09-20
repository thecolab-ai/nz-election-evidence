// The coverage statement the explorer shows must equal the catalogue, the merged registry and the ingestion route
// coverage. It states which ROUTES exist; what is HELD is read from the database by the explorer and is never baked in.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildCoverageFile } from "../ingest/src/loaders/coverage_build.ts";
import { SOURCE_ROUTES, STATS_REFRESH } from "../ingest/src/loaders/coverage.ts";
import { coverageCounts, heldFor, RELEASE_COVERAGE } from "../web/src/lib/release-coverage.ts";

const root = new URL("../", import.meta.url);

test("the explorer's coverage file is the generated one: 24 products, in catalogue order, with the catalogue's words", async () => {
  assert.equal(await readFile(new URL("web/src/lib/release-coverage.json", root), "utf-8"), await buildCoverageFile(), "run `node src/loaders/coverage_build.ts --write` in ingest/");
  const catalogue = JSON.parse(await readFile(new URL("catalogue/sources.json", root), "utf-8")) as { product_id: string; title: string; publisher: string; record_count: number }[];
  assert.deepEqual(RELEASE_COVERAGE.map((r) => [r.product_id, r.title, r.publisher, r.catalogue_record_count]), catalogue.map((p) => [p.product_id, p.title, p.publisher, p.record_count]));
  assert.equal(coverageCounts().total, 24);
  assert.equal(coverageCounts().with_backfill_route, 24, "every catalogue product has an explicit backfill route");
});

test("a route shown to readers is a registered source that maps to that product, with a state that allows the claim", async () => {
  const config = JSON.parse(await readFile(new URL("supabase/functions/_shared/sources.config.json", root), "utf-8")) as {
    sources: { source_id: string; enabled: boolean; adapter_kind: string; adapter_name: string; catalogue_products?: { product_id: string }[] }[];
  };
  for (const row of RELEASE_COVERAGE) {
    for (const id of [...row.backfill_source_ids, ...row.refresh_source_ids]) {
      const source = config.sources.find((s) => s.source_id === id);
      assert.ok(source, `${row.product_id}: ${id} is registered`);
      assert.ok((source.catalogue_products ?? []).some((p) => p.product_id === row.product_id), `${row.product_id}: ${id} maps to it`);
    }
    for (const id of row.backfill_source_ids) assert.equal(SOURCE_ROUTES[id].state, "loaded_and_reconciled", id);
    // A blocked, challenged or probe-only source is never shown as a refresh route.
    for (const id of row.refresh_source_ids) assert.ok(["working", "exercised_not_run_in_full"].includes(SOURCE_ROUTES[id].state) || STATS_REFRESH[id]?.state === "working_cli_only", id);
    if (row.refresh === "scheduled") assert.ok(row.refresh_source_ids.some((id) => config.sources.find((s) => s.source_id === id)!.enabled), `${row.product_id}: a scheduled refresh needs an enabled source`);
    if (row.refresh === "none" || row.refresh === "pending_decision" || row.refresh === "exercised_only") assert.ok(row.refresh_gap, `${row.product_id}: says why there is no working refresh route`);
  }
});

test("the coverage file claims no loaded data: with an empty store every product reads as not held", () => {
  for (const row of RELEASE_COVERAGE) assert.equal(heldFor(row, []).held, false, row.product_id);
  const text = JSON.stringify(RELEASE_COVERAGE);
  assert.ok(!/\b(approved|licen[cs]ed|cleared)\b/i.test(text), "a coverage statement never speaks about rights");
});

test("every owner field decision names a source this project has a route for, and only those", async () => {
  const owner = JSON.parse(await readFile(new URL("governance/owner-authorizations.json", root), "utf-8")) as { authorizations: { status: string; scopes: { scope: string; source_id?: string }[] }[] };
  const routed = new Set([...RELEASE_COVERAGE.flatMap((r) => [...r.backfill_source_ids, ...r.refresh_source_ids]), "stats_nz_census_2013_meshblock", "election_2026_official_page_status_export", "election_2026_boundary_map_links_export"]);
  const decided = owner.authorizations.filter((a) => a.status === "active").flatMap((a) => a.scopes).filter((s) => s.scope === "source_fields" || s.scope === "statistical_facts").map((s) => s.source_id!);
  for (const id of decided) assert.ok(routed.has(id), `${id}: an owner field decision for a source without a route`);
  // The four sources of the first connected release keep their decision.
  for (const id of ["nz_parliament_mp_directory", "nz_parliament_current_bills", "nz_government_releases_feed", "baseline_2023_candidacies_export"]) assert.ok(decided.includes(id), id);
});
