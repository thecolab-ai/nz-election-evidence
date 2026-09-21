// One registry. The three family fragments and the core sources are merged here, and the merged result is what is
// committed as supabase/functions/_shared/sources.config.json (the file the Edge Function, the CLI and the explorer's
// tests all read). The fragments stay the place a family edits; `node src/loaders/registry_build.ts --write` rebuilds the
// committed file, and a test fails when the two drift.
//
// Merging is refused, not resolved, on: a source id or schedule key owned twice, a registry product defined twice
// with different facts, a rights row that does not exist, a rights row that does not list the product a source
// claims (unless the exception is written down below with its reason), and a schedule that names a CLI-only adapter.

import { CLI_ONLY_ADAPTERS, LIVE_ADAPTERS } from "../../../supabase/functions/_shared/adapters/index.ts";
import { validateSourcesFile } from "../../../supabase/functions/_shared/registry.ts";
import type { SourceConfig, SourcesFile } from "../../../supabase/functions/_shared/types.ts";
import { ELECTION_LIVE_SOURCES, ELECTION_SCHEDULES } from "../families/election/live.ts";
import { ELECTION_EXPORT_SOURCES, ELECTION_REGISTRY_PRODUCTS } from "../families/election/registry_fragment.ts";
import { PARLIAMENT_REGISTRY_PRODUCTS, PARLIAMENT_SCHEDULES, PARLIAMENT_SOURCES } from "../families/parliament/registry_fragment.ts";
import { STATS_REGISTRY_FRAGMENT, STATS_REGISTRY_PRODUCT } from "../families/stats/registry_fragment.ts";
import type { FamilyId } from "./contract.ts";

/** Bumped whenever the merged registry changes shape or membership; part of every run manifest. */
export const MERGED_CONFIG_VERSION = 2;

/** Export adapters that only a family importer can run. The generic flat importer refuses them. */
export const FAMILY_EXPORT_ADAPTERS: { [adapterName: string]: FamilyId } = {
  election_family_export: "election",
  parliament_family_export: "parliament",
  stats_family_artifact: "statistics",
  stats_family_fetch: "statistics",
};

export interface Fragment { family: FamilyId; sources: SourceConfig[]; products: SourcesFile["registry_products"]; schedules: SourcesFile["schedules"] }

export function fragments(): Fragment[] {
  return [
    { family: "election", sources: [...ELECTION_EXPORT_SOURCES.map((e) => e.source), ...ELECTION_LIVE_SOURCES], products: ELECTION_REGISTRY_PRODUCTS, schedules: ELECTION_SCHEDULES },
    { family: "parliament", sources: PARLIAMENT_SOURCES, products: PARLIAMENT_REGISTRY_PRODUCTS, schedules: PARLIAMENT_SCHEDULES },
    { family: "statistics", sources: STATS_REGISTRY_FRAGMENT, products: [STATS_REGISTRY_PRODUCT], schedules: [] },
  ];
}

export function sourceFamilies(): Map<string, FamilyId> {
  const owners = new Map<string, FamilyId>();
  for (const fragment of fragments()) for (const source of fragment.sources) owners.set(source.source_id, fragment.family);
  return owners;
}

/** The core part of a registry file: everything no family fragment owns. Makes the merge repeatable. */
export function coreOf(file: SourcesFile, parts: Fragment[] = fragments()): SourcesFile {
  const owned = new Set(parts.flatMap((f) => f.sources.map((s) => s.source_id)));
  const ownedSchedules = new Set(parts.flatMap((f) => f.schedules.map((s) => s.schedule_key)));
  const familyProducts = new Set(parts.flatMap((f) => f.products.map((p) => p.registry_key)));
  return {
    config_version: file.config_version,
    registry_products: file.registry_products.filter((p) => !familyProducts.has(p.registry_key)),
    sources: file.sources.filter((s) => !owned.has(s.source_id)),
    schedules: file.schedules.filter((s) => !ownedSchedules.has(s.schedule_key)),
  };
}

export function mergeRegistry(committed: SourcesFile, parts: Fragment[] = fragments()): { file: SourcesFile; problems: string[] } {
  const core = coreOf(committed, parts);
  const problems: string[] = [];
  const sources = [...core.sources];
  const products = [...core.registry_products];
  const schedules = [...core.schedules];
  const seenSource = new Map<string, string>(core.sources.map((s) => [s.source_id, "core"]));
  const seenSchedule = new Map<string, string>(core.schedules.map((s) => [s.schedule_key, "core"]));
  for (const fragment of parts) {
    for (const source of fragment.sources) {
      const owner = seenSource.get(source.source_id);
      if (owner) problems.push(`source ${source.source_id} is defined by both ${owner} and ${fragment.family}`);
      else {
        seenSource.set(source.source_id, fragment.family);
        sources.push(source);
      }
    }
    for (const product of fragment.products) {
      const existing = products.find((p) => p.registry_key === product.registry_key);
      if (!existing) products.push(product);
      else if (existing.title !== product.title || existing.domain !== product.domain) problems.push(`registry product ${product.registry_key} is defined twice with different facts`);
    }
    for (const schedule of fragment.schedules) {
      const owner = seenSchedule.get(schedule.schedule_key);
      if (owner) problems.push(`schedule ${schedule.schedule_key} is defined by both ${owner} and ${fragment.family}`);
      else {
        seenSchedule.set(schedule.schedule_key, fragment.family);
        schedules.push(schedule);
      }
    }
  }
  const file: SourcesFile = { config_version: MERGED_CONFIG_VERSION, registry_products: products, sources, schedules };
  const keys = new Set(products.map((p) => p.registry_key));
  for (const source of sources) {
    if (source.registry_key && !keys.has(source.registry_key)) problems.push(`source ${source.source_id}: registry product ${source.registry_key} is not defined`);
    if (source.adapter_kind === "live_fetch" && !LIVE_ADAPTERS[source.adapter_name] && !CLI_ONLY_ADAPTERS.has(source.adapter_name)) {
      problems.push(`source ${source.source_id}: adapter ${source.adapter_name} does not exist`);
    }
    const probe = source.adapter_name === "availability_probe";
    if (source.adapter_kind === "live_fetch" && !source.enabled && !probe && !source.disabled_because) problems.push(`source ${source.source_id}: a disabled live source must state disabled_because`);
    if ((source.enabled || probe || source.adapter_kind !== "live_fetch") && source.disabled_because) problems.push(`source ${source.source_id}: disabled_because belongs on a disabled live source only`);
    if (CLI_ONLY_ADAPTERS.has(source.adapter_name) && source.disabled_because !== "cli_only") problems.push(`source ${source.source_id}: a CLI-only adapter must say disabled_because cli_only`);
  }
  for (const schedule of schedules) {
    const source = sources.find((s) => s.source_id === schedule.source_id);
    if (source && CLI_ONLY_ADAPTERS.has(source.adapter_name)) problems.push(`schedule ${schedule.schedule_key}: ${source.adapter_name} never runs inside the Edge Function`);
  }
  return { file, problems: [...problems, ...validateSourcesFile(file)] };
}

// Rights ---------------------------------------------------------------------------------------------------------------

export interface RightsRow { rights_id: string; publisher: string; source_url: string; product_ids: string[]; review_status: string; default_release: string }

/**
 * A source may sit under a rights row that does not list its catalogue product ONLY where the row is the one for the
 * page the data really comes from. Each case is written down; an unlisted mismatch fails the merge.
 */
export const RIGHTS_EXCEPTIONS: { source_id: string; product_id: string; rights_id: string; reason: string }[] = [
  {
    source_id: "baseline_2023_candidacies_export", product_id: "P04", rights_id: "RIGHTS-01",
    reason: "Every one of the 963 rows cites the official 2023 results site, which is the page RIGHTS-01 records. RIGHTS-03 lists P04 but records a different page. Decided and explained in docs/database/connected-release.md.",
  },
  {
    source_id: "parliament_export_minister_roles", product_id: "P10", rights_id: "RIGHTS-08",
    reason: "The roles are read from the Government's own minister pages, so they sit under the Government's rights row, not under Parliament's members page (RIGHTS-13), which lists P10.",
  },
];

export function rightsProblems(file: SourcesFile, register: RightsRow[]): string[] {
  const problems: string[] = [];
  const rows = new Map(register.map((row) => [row.rights_id, row]));
  for (const source of file.sources) {
    const where = `source ${source.source_id}`;
    if (!source.rights_id) {
      problems.push(`${where}: no rights row named`);
      continue;
    }
    const row = rows.get(source.rights_id);
    if (!row) {
      problems.push(`${where}: rights row ${source.rights_id} is not in the register`);
      continue;
    }
    for (const product of source.catalogue_products ?? []) {
      if (row.product_ids.includes(product.product_id)) continue;
      const exception = RIGHTS_EXCEPTIONS.find((e) => e.source_id === source.source_id && e.product_id === product.product_id && e.rights_id === source.rights_id);
      if (!exception) problems.push(`${where}: claims ${product.product_id}, which rights row ${source.rights_id} does not list`);
    }
  }
  // Nothing in a registry may present a rights question as answered.
  for (const source of file.sources) {
    const text = [source.title, source.access_note, source.blocked_reason, ...(source.catalogue_products ?? []).map((p) => p.mapping_note)].filter(Boolean).join(" ");
    if (/\b(rights (approved|cleared)|licen[cs]e granted|permission granted|publisher[- ]approved)\b/i.test(text)) problems.push(`source ${source.source_id}: wording presents a pending rights question as answered`);
  }
  return problems;
}
