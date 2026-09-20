// The live routes' proposed source configurations and schedules, checked with the shared registry's own validator.
// Offline: nothing here contacts a publisher.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSourcesFile } from "../../supabase/functions/_shared/registry.ts";
import type { SourcesFile } from "../../supabase/functions/_shared/types.ts";
import sourcesFile from "../../supabase/functions/_shared/sources.config.json" with { type: "json" };
import { PARLIAMENT_LIVE_ADAPTERS, PARLIAMENT_LIVE_SCHEDULES, PARLIAMENT_LIVE_SOURCES } from "../src/families/parliament/live/index.ts";

const base = sourcesFile as unknown as SourcesFile;

test("live sources and schedules pass the shared registry validation and clash with nothing already registered", () => {
  const products = [...base.registry_products];
  for (const key of new Set(PARLIAMENT_LIVE_SOURCES.map((s) => s.registry_key!))) if (!products.some((p) => p.registry_key === key)) products.push({ registry_key: key, title: key, domain: "Parliament and law" });
  const merged: SourcesFile = { ...base, registry_products: products, sources: [...base.sources, ...PARLIAMENT_LIVE_SOURCES], schedules: [...base.schedules, ...PARLIAMENT_LIVE_SCHEDULES] };
  assert.deepEqual(validateSourcesFile(merged), []);
  assert.equal(new Set(merged.sources.map((s) => s.source_id)).size, merged.sources.length);
  assert.equal(new Set(merged.schedules.map((s) => s.schedule_key)).size, merged.schedules.length);
});

test("every source names a registered adapter; backfill and blocked routes are never scheduled; function limits are kept", () => {
  for (const source of PARLIAMENT_LIVE_SOURCES) {
    assert.ok(PARLIAMENT_LIVE_ADAPTERS[source.adapter_name], source.source_id);
    assert.equal(PARLIAMENT_LIVE_ADAPTERS[source.adapter_name].name, source.adapter_name);
    assert.ok(source.min_interval_ms! >= 3000, "at least three seconds between requests to one host");
    assert.ok(source.access_basis === "public_undocumented_endpoint" || source.access_basis === "public_page");
  }
  const byId = new Map(PARLIAMENT_LIVE_SOURCES.map((s) => [s.source_id, s]));
  for (const id of ["nz_parliament_written_questions_backfill", "nz_parliament_bill_publications", "nz_government_releases_listing"]) {
    assert.equal(byId.get(id)!.enabled, false, id);
    assert.ok(byId.get(id)!.blocked_reason, id);
    assert.ok(!PARLIAMENT_LIVE_SCHEDULES.some((s) => s.source_id === id), id);
  }
  assert.equal(byId.get("nz_parliament_written_questions_backfill")!.adapter_options!.mode, "backfill");
  assert.equal(byId.get("nz_parliament_written_questions_recent")!.adapter_options!.mode, "incremental");
  for (const schedule of PARLIAMENT_LIVE_SCHEDULES) {
    assert.ok(schedule.max_records >= 100 && schedule.max_records <= 2000, schedule.schedule_key);
    assert.ok(schedule.max_runtime_seconds <= 140, schedule.schedule_key);
  }
  // Only a source whose complete walk is the publisher's whole current list may tombstone.
  assert.deepEqual(PARLIAMENT_LIVE_SOURCES.filter((s) => s.snapshot_semantics === "complete_snapshot").map((s) => s.source_id).sort(),
    ["nz_parliament_committee_business", "nz_parliament_committee_reports"]);
});
