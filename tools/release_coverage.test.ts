// The coverage statement the explorer shows must equal the catalogue and the ingestion configuration.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { coverageCounts, RELEASE_COVERAGE } from "../web/src/lib/release-coverage.ts";

const root = new URL("../", import.meta.url);

test("coverage shown to readers matches the catalogue: 24 products, 3 live, 1 export, 20 not in the store", async () => {
  const catalogue = JSON.parse(await readFile(new URL("catalogue/sources.json", root), "utf-8")) as { product_id: string; title: string; publisher: string }[];
  assert.deepEqual(RELEASE_COVERAGE.map((r) => [r.product_id, r.title, r.publisher]), catalogue.map((p) => [p.product_id, p.title, p.publisher]));
  assert.deepEqual(coverageCounts(), { total: 24, live: 3, export: 1, none: 20 });
});

test("a product is called live or export only if an ENABLED live source, or the pinned export contract, maps to it", async () => {
  const config = JSON.parse(await readFile(new URL("supabase/functions/_shared/sources.config.json", root), "utf-8")) as {
    sources: { source_id: string; enabled: boolean; adapter_kind: string; catalogue_products?: { product_id: string }[]; export_contract?: { expectedInput?: { rows: number } } }[];
  };
  const expected = new Map<string, { route: string; source_id: string }>();
  for (const source of config.sources) {
    const route = source.adapter_kind === "live_fetch" && source.enabled ? "live" : source.adapter_kind === "export_import" && source.export_contract ? "export" : null;
    if (!route) continue; // a disabled probe maps to a product without importing it: that product stays "none"
    for (const product of source.catalogue_products ?? []) expected.set(product.product_id, { route, source_id: source.source_id });
  }
  for (const row of RELEASE_COVERAGE) {
    const want = expected.get(row.product_id);
    assert.equal(row.route, want?.route ?? "none", row.product_id);
    assert.equal(row.source_id, want?.source_id, row.product_id);
  }
  const contract = config.sources.find((s) => s.source_id === "baseline_2023_candidacies_export")?.export_contract;
  assert.equal(contract?.expectedInput?.rows, 963);
});

test("the owner's field decisions cover exactly the sources this release holds", async () => {
  const owner = JSON.parse(await readFile(new URL("governance/owner-authorizations.json", root), "utf-8")) as { authorizations: { scopes: { scope: string; source_id?: string }[] }[] };
  const decided = owner.authorizations.flatMap((a) => a.scopes).filter((s) => s.scope === "source_fields").map((s) => s.source_id).sort();
  assert.deepEqual(decided, RELEASE_COVERAGE.filter((r) => r.route !== "none").map((r) => r.source_id).sort());
});
