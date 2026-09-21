// Statistics family: the backfill exporter. Reads the upstream collection through the read-only recipe, maps every
// row through the typed mappers and writes one private artifact per source. It never writes upstream, and it
// reconciles what it read against what it wrote before it reports success.

import { ArtifactWriter } from "./artifact.ts";
import {
  type ArtifactManifest, ContractError, type MetaRow, type ReconciliationLine, type RouteRow, sha256Text, upstreamUtc,
} from "./contract.ts";
import {
  CENSUS_2023_USED, type CensusDatasetInfo, foldCatalogueVersions, mapCatalogueRecord, mapCensus, mapCensusProduct, type MapContext,
  mapDedicatedSeries, mapHealth, mapMsd, mapSelectedSeries, mapTenancy, MetaCollector, type SeriesSourceInfo, type Upstream,
} from "./mappers.ts";
import type { StatsSourcePlan } from "./routes.ts";
import { type QueryRunner, RECIPES } from "./upstream.ts";

export const EXPORTER_VERSION = "1.0.0";

const FACT_MAPPERS: { [upstreamSource: string]: (ctx: MapContext, c: MetaCollector, record: Upstream, payload: Upstream) => ReturnType<typeof mapTenancy> } = {
  stats_nz_series: mapSelectedSeries,
  tenancy_rental_bonds: mapTenancy,
  msd_benefits: mapMsd,
  healthnz_data: mapHealth,
  stats_nz_2023_census: (ctx, collector, record, payload) => {
    collector.drop(payload, CENSUS_2023_USED);
    const info: CensusDatasetInfo = {
      title: CENSUS_2023_TITLES[String(payload.dataset_id)] ?? String(payload.dataset_id), coverage_note: "Selected 2023 Census products; the count does not imply all Census outputs.",
      source_bytes: null, retrieved_at: null, capture_count: 1,
    };
    return mapCensus(ctx, collector, "operational", payload, upstreamUtc(String(record.observed_at)), info, "");
  },
};

const CENSUS_2023_TITLES: { [datasetKey: string]: string } = {
  "statsnz.census.2023.population_ethnicity_age_maori_descent_dwellings": "2023 Census national and subnational usually resident population counts and dwelling counts",
  "statsnz.census.2023.electoral_populations": "Number of electorates and electoral populations: 2023 Census",
};

function payloadOf(record: Upstream): Upstream {
  try {
    const parsed = JSON.parse(String(record.payload_json));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Upstream;
  } catch {
    throw new ContractError("upstream payload is not a JSON object");
  }
}

async function all(run: QueryRunner, sql: string): Promise<Upstream[]> {
  const rows: Upstream[] = [];
  for await (const row of run(sql)) rows.push(row);
  return rows;
}

function num(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new ContractError("upstream count is not a whole number");
  return n;
}

export async function exportSource(plan: StatsSourcePlan, run: QueryRunner, root: string, log: (message: string) => void = () => undefined): Promise<ArtifactManifest> {
  const ctx: MapContext = { sourceId: plan.source_id, publisher: plan.publisher, officialUrl: plan.official_url, historical: plan.historical };
  const collector = new MetaCollector();
  const writer = await ArtifactWriter.open(root, plan.source_id);
  const reconciliation: ReconciliationLine[] = [];
  const findings: string[] = [];
  const statements: string[] = [];
  const catalogue: MetaRow[] = [];
  const upstreamByDataset = new Map<string, number>();
  const observedTimes: string[] = [];
  const query = (sql: string) => { statements.push(sql.replace(/\s+/g, " ").trim()); return sql; };
  let overlapRows: number | null = null;

  if (plan.upstream.operational_source) {
    const upstreamSource = plan.upstream.operational_source;
    const counts = await all(run, query(RECIPES.operationalCounts(upstreamSource)));
    for (const c of counts) observedTimes.push(upstreamUtc(String(c.observed_from)), upstreamUtc(String(c.observed_to)));
    const factCounts = counts.find((c) => c.record_kind === "fact");
    if (factCounts) {
      const mapper = FACT_MAPPERS[upstreamSource];
      if (!mapper) throw new ContractError(`no typed mapper for upstream source ${upstreamSource}`);
      let read = 0;
      for await (const record of run(query(RECIPES.operationalFacts(upstreamSource)))) {
        read++;
        const row = mapper(ctx, collector, record, payloadOf(record));
        upstreamByDataset.set(row.dataset_key, (upstreamByDataset.get(row.dataset_key) ?? 0) + 1);
        await writer.observation(row);
        if (read % 50000 === 0) log(`${plan.source_id}: ${read} facts mapped`);
      }
      const ids = num(factCounts.record_ids);
      const stored = num(factCounts.stored_rows);
      reconciliation.push({
        what: "operational fact records (current version of each record id) -> observations", upstream_rows: ids, artifact_rows: read, difference: read - ids,
        explanation: read === ids ? "every current fact record became exactly one observation" : "UNEXPLAINED: the current-record view and the distinct record-id count disagree",
      });
      if (stored !== ids) {
        reconciliation.push({
          what: "operational fact rows stored across all collection runs", upstream_rows: stored, artifact_rows: read, difference: read - stored,
          explanation: `${stored - ids} stored rows are earlier collection runs of the same record ids (${num(factCounts.runs)} runs); only the current version of each id is an observation, so nothing is counted twice`,
        });
      }
      if (read !== ids) throw new ContractError(`${plan.source_id}: read ${read} facts but upstream holds ${ids} fact record ids`);
    }
    const catalogueKinds = counts.filter((c) => c.record_kind !== "fact");
    if (catalogueKinds.length) {
      const versions: Parameters<typeof foldCatalogueVersions>[0] = [];
      const ids = new Set<string>();
      for await (const record of run(query(RECIPES.operationalCatalogue(upstreamSource)))) {
        ids.add(String(record.record_id));
        versions.push({ fields: mapCatalogueRecord(ctx, collector, record, payloadOf(record)), observedAt: upstreamUtc(String(record.observed_at)) });
      }
      const folded = foldCatalogueVersions(versions);
      catalogue.push(...folded);
      const storedRows = catalogueKinds.reduce((sum, c) => sum + num(c.stored_rows), 0);
      const recordIds = catalogueKinds.reduce((sum, c) => sum + num(c.record_ids), 0);
      if (versions.length !== storedRows || ids.size !== recordIds) throw new ContractError(`${plan.source_id}: catalogue rows read (${versions.length}/${ids.size}) differ from upstream counts (${storedRows}/${recordIds})`);
      reconciliation.push({
        what: "operational catalogue records (distinct record ids) -> catalogue entries (distinct entry keys)", upstream_rows: recordIds, artifact_rows: new Set(folded.map((f) => f.entry_key)).size,
        difference: new Set(folded.map((f) => f.entry_key)).size - recordIds, explanation: "one entry key per upstream record id",
      });
      reconciliation.push({
        what: "operational catalogue stored versions -> catalogue entry versions", upstream_rows: storedRows, artifact_rows: folded.length, difference: folded.length - storedRows,
        explanation: folded.length === storedRows ? "every stored version differs in allowlisted content" : `${storedRows - folded.length} stored versions were re-collections whose allowlisted content is identical to another version of the same record; they are folded into that version's first/last observed times and observation count`,
      });
    }
  }

  if (plan.upstream.census_products) {
    const versions: Parameters<typeof foldCatalogueVersions>[0] = [];
    const products = new Set<string>();
    for await (const row of run(query(RECIPES.censusProducts()))) {
      products.add(String(row.product_id));
      const observedAt = upstreamUtc(String(row.captured_at));
      observedTimes.push(observedAt);
      versions.push({ fields: mapCensusProduct(ctx, row), observedAt });
    }
    const folded = foldCatalogueVersions(versions);
    catalogue.push(...folded);
    reconciliation.push({
      what: "dedicated census product finder rows -> product catalogue entries", upstream_rows: versions.length, artifact_rows: folded.length, difference: folded.length - versions.length,
      explanation: folded.length === versions.length ? `one entry per product (${products.size} products); an index of products, never observations` : "identical re-captures folded",
    });
  }

  if (plan.upstream.census_datasets) {
    const sources = await all(run, query(RECIPES.censusSources()));
    const counts = await all(run, query(RECIPES.censusCounts()));
    for (const datasetId of plan.upstream.census_datasets) {
      const captures = sources.filter((s) => s.dataset_id === datasetId);
      if (captures.length === 0) throw new ContractError(`no upstream source row for census dataset ${datasetId}`);
      if (new Set(captures.map((s) => s.sha256)).size !== 1) throw new ContractError(`census dataset ${datasetId} was captured as more than one file; each needs its own release`);
      const times = captures.map((s) => upstreamUtc(String(s.retrieved_at))).sort();
      observedTimes.push(...times);
      const info: CensusDatasetInfo = {
        title: String(captures[0].title).slice(0, 500), coverage_note: [captures[0].coverage, captures[0].licence ? `Upstream licence note (unverified): ${captures[0].licence}` : null].filter(Boolean).join(" | ").slice(0, 1000) || null,
        source_bytes: num(captures[0].bytes), retrieved_at: times[0], capture_count: captures.length,
      };
      let read = 0;
      for await (const row of run(query(RECIPES.censusObservations(datasetId)))) {
        read++;
        await writer.observation(mapCensus(ctx, collector, "dedicated_census", row, upstreamUtc(String(row.captured_at)), info, ""));
        if (read % 100000 === 0) log(`${plan.source_id}: ${read} census observations mapped`);
      }
      upstreamByDataset.set(datasetId, read);
      const stored = num(counts.find((c) => c.dataset_id === datasetId)?.stored_rows ?? 0);
      reconciliation.push({
        what: `dedicated census observations of ${datasetId} -> observations`, upstream_rows: stored, artifact_rows: read, difference: read - stored,
        explanation: read === stored ? "every upstream observation became exactly one observation" : "UNEXPLAINED",
      });
      if (read !== stored) throw new ContractError(`${plan.source_id}: read ${read} census observations but upstream holds ${stored}`);
    }
    if (plan.upstream.overlap) {
      const overlap = await all(run, query(RECIPES.operationalCounts(plan.upstream.overlap.operational_source)));
      const fact = overlap.find((c) => c.record_kind === "fact");
      overlapRows = fact ? num(fact.record_ids) : 0;
      reconciliation.push({
        what: `overlapping ${plan.upstream.overlap.route} route (${num(fact?.stored_rows ?? 0)} stored rows, ${overlapRows} record ids) -> observations`, upstream_rows: overlapRows, artifact_rows: 0, difference: -overlapRows,
        explanation: `not imported: ${plan.upstream.overlap.note} Importing both would count the same publisher cells twice.`,
      });
    }
  }

  if (plan.upstream.series_all_datasets) {
    const sources = await all(run, query(RECIPES.seriesSources()));
    const counts = await all(run, query(RECIPES.seriesCounts()));
    const datasetIds = [...new Set(sources.map((s) => String(s.dataset_id)))].sort();
    let recovered = 0;
    for (const datasetId of datasetIds) {
      const captures = sources.filter((s) => s.dataset_id === datasetId).sort((a, b) => String(a.retrieved_at).localeCompare(String(b.retrieved_at)));
      if (new Set(captures.map((s) => s.source_sha256)).size !== 1) throw new ContractError(`series dataset ${datasetId} was captured as more than one file; each needs its own release`);
      const snapshots = counts.filter((c) => c.dataset_id === datasetId);
      if (new Set(snapshots.map((c) => num(c.observation_keys))).size !== 1) throw new ContractError(`captures of ${datasetId} hold different observation sets although the file hash is the same`);
      const latest = captures[captures.length - 1];
      const times = captures.map((s) => upstreamUtc(String(s.retrieved_at)));
      observedTimes.push(...times);
      const info: SeriesSourceInfo = {
        title: String(latest.title), source_url: String(latest.source_url), release_vintage: String(latest.release_vintage), retrieved_at: times[0],
        source_bytes: num(latest.source_bytes), capture_count: captures.length, source_sha256: /^[0-9a-f]{64}$/.test(String(latest.source_sha256)) ? String(latest.source_sha256) : null,
      };
      let read = 0;
      for await (const row of run(query(RECIPES.seriesObservations(datasetId, String(latest.snapshot_id))))) {
        read++;
        const mapped = mapDedicatedSeries(ctx, collector, row, info);
        if (mapped.value !== null && row.value_parse_status !== "numeric") recovered++;
        await writer.observation(mapped);
        if (read % 50000 === 0) log(`${plan.source_id}: ${datasetId} ${read} observations mapped`);
      }
      upstreamByDataset.set(datasetId, read);
      const storedAll = snapshots.reduce((sum, c) => sum + num(c.stored_rows), 0);
      const storedLatest = num(snapshots.find((c) => c.snapshot_id === latest.snapshot_id)?.stored_rows ?? 0);
      reconciliation.push({
        what: `dedicated series observations of ${datasetId} (${captures.length} captures of one file) -> observations`, upstream_rows: storedAll, artifact_rows: read, difference: read - storedAll,
        explanation: read === storedLatest ? `${storedAll - read} stored rows are the other ${captures.length - 1} capture(s) of the byte-identical file (same SHA-256, same observation keys); one capture is imported and capture_count records the rest` : "UNEXPLAINED",
      });
      if (read !== storedLatest) throw new ContractError(`${plan.source_id}: read ${read} observations of ${datasetId} but the capture holds ${storedLatest}`);
    }
    if (recovered) findings.push(`${recovered} observations carry a number that the upstream normaliser had recorded as absent: the publisher file uses other column names (SER_REF / TIME_REF / DATA_VAL) and upstream kept those columns verbatim, so the number, period and series reference were read from the publisher's own columns.`);
  }

  // One route decision per dataset. Overlapping routes are listed with their counts; the counts are never added.
  const routes: RouteRow[] = [...collector.datasets.values()].map((dataset) => ({
    kind: "route" as const, observation_family: dataset.dataset_key, canonical_route: dataset.route,
    overlapping_routes: plan.upstream.overlap ? [plan.upstream.overlap.route] : [],
    upstream_rows_by_route: { [dataset.route]: upstreamByDataset.get(dataset.dataset_key) ?? 0, ...(plan.upstream.overlap && overlapRows !== null ? { [plan.upstream.overlap.route]: overlapRows } : {}) },
    decision_note: plan.upstream.overlap
      ? `Imported through ${dataset.route}. ${plan.upstream.overlap.note} The ${plan.upstream.overlap.route} rows are a subset and are not imported.`
      : `Imported through ${dataset.route}; no other upstream route holds this publisher file.`,
  }));

  if (collector.dropped.size) {
    findings.push("upstream payload keys not on the allowlist (dropped, never read into a row): " + [...collector.dropped].sort().map(([k, n]) => `${k} x${n}`).join(", "));
  }
  if (writer.observations === 0 && catalogue.length === 0) throw new ContractError(`${plan.source_id}: upstream held nothing to export; treated as a fault, not as an empty source`);

  const meta: MetaRow[] = [...routes, ...collector.datasets.values(), ...collector.releases.values(), ...collector.series.values(), ...collector.geographies.values(), ...catalogue];
  observedTimes.sort();
  return writer.finish(meta, {
    source_id: plan.source_id,
    producer: { route: "warehouse_export", exporter_version: EXPORTER_VERSION, recipe_sha256: sha256Text(EXPORTER_VERSION + "\n" + statements.join("\n")) },
    collected_from: observedTimes[0] ?? null, collected_to: observedTimes[observedTimes.length - 1] ?? null, reconciliation, findings,
  });
}
