// Statistics family: registry fragment.
//
// The shared source registry (supabase/functions/_shared/sources.config.json) is not edited by this family. The
// coordinator merges STATS_REGISTRY_FRAGMENT into it (see ingest/src/families/stats/INTEGRATION.md). Until then the
// family CLI can sync this fragment on its own into a disposable database, through the same sync_registry function.
//
// Sources with a fresh-fetch route are registered as live sources (allowlisted hosts, a rights row, an access
// basis) but are NEVER schedule-enabled: their files are larger than the Edge Function budget, so they run from the
// family CLI only. Their backfill is an export_import-mode run of the same source. Sources without a fresh-fetch
// route are registered as export imports of the private artifact.

import type { ExportContract, SourceConfig, SourcesFile } from "../../../../supabase/functions/_shared/types.ts";
import { ARTIFACT_DIR_ENV } from "./artifact.ts";
import { STATS_SOURCES, type StatsSourcePlan } from "./routes.ts";

const ARTIFACT_CONTRACT: ExportContract = {
  fileEnv: ARTIFACT_DIR_ENV,
  recordKind: "stat_artifact_row",
  idField: "content_hash",
  sourceUrlField: "source_url",
  observedAtField: "retrieved_at",
  // The generic row contract does not describe this input: it is a directory of typed rows, and its closed
  // allowlist is ingest/src/families/stats/contract.ts (validateRow). Every row is checked against it before a
  // run starts; a key outside it refuses the artifact.
  allowedFields: [],
  droppedFields: [],
  expectedRowsNote: "Row counts are pinned per artifact by its manifest (file hashes and row counts) and reconciled upstream -> artifact -> store in the load receipt.",
};

const ACCESS_BASIS: { [sourceId: string]: SourceConfig["access_basis"] } = {
  stats_rbnz_catalogue: "documented_api",
};

const CADENCE_SECONDS: { [sourceId: string]: number } = {
  stats_rbnz_catalogue: 7 * 86400, stats_nz_csv_catalogue: 86400, stats_nz_selected_series: 30 * 86400, stats_tenancy_rental_bonds: 30 * 86400,
  stats_healthnz_data: 30 * 86400, stats_msd_benefits: 30 * 86400,
};

function sourceConfig(plan: StatsSourcePlan): SourceConfig {
  const common = {
    source_id: plan.source_id, registry_key: "statistics", title: plan.title, publisher: plan.publisher, official_url: plan.official_url,
    rights_id: plan.rights_id, view_scope: "statistics" as const, enabled: false, catalogue_products: plan.products,
  };
  if (plan.incremental === "none") {
    return {
      ...common, adapter_kind: "export_import", adapter_name: "stats_family_artifact", allowed_hosts: [], snapshot_semantics: "append_only_feed",
      blocked_reason: `No incremental route: ${plan.incremental_note}`, export_contract: ARTIFACT_CONTRACT,
    };
  }
  const officialHost = new URL(plan.official_url).hostname;
  return {
    ...common, adapter_kind: "live_fetch", adapter_name: "stats_family_fetch", allowed_hosts: [...new Set([officialHost, ...plan.live_hosts])].sort(),
    access_basis: ACCESS_BASIS[plan.source_id] ?? "public_page", snapshot_semantics: "append_only_feed", min_interval_ms: 2000,
    expected_cadence_seconds: CADENCE_SECONDS[plan.source_id],
    disabled_because: "cli_only",
    blocked_reason: "Runs from the statistics family CLI only (fetch, then load): the publisher files are larger than the Edge Function budget, so this source is never schedule-enabled.",
    access_note: plan.incremental_note,
  };
}

export const STATS_REGISTRY_PRODUCT = { registry_key: "statistics", title: "Official statistics and statistical catalogues", domain: "Statistics", notes: "Typed observations with unit, period, geography edition, release vintage and value status; catalogue entries kept apart from observations." };

export const STATS_REGISTRY_FRAGMENT: SourceConfig[] = STATS_SOURCES.map(sourceConfig);

/** A registry file holding only this family, for validation and for syncing a disposable database. */
export function fragmentFile(configVersion = 1): SourcesFile {
  return { config_version: configVersion, registry_products: [STATS_REGISTRY_PRODUCT], sources: STATS_REGISTRY_FRAGMENT, schedules: [] };
}
