#!/usr/bin/env node
// Statistics family CLI.
//
//   node src/families/stats/cli.ts plan                          sources, routes and products (no network, no writes)
//   node src/families/stats/cli.ts export <source_id|all>        backfill: read-only upstream export -> private artifact
//   node src/families/stats/cli.ts fetch <source_id|all>         incremental: fresh anonymous fetch -> private artifact
//   node src/families/stats/cli.ts verify <source_id|all>        re-hash and re-validate an artifact (no writes)
//   node src/families/stats/cli.ts load <source_id|all> [--dry-run] [--fresh] [--receipt FILE]
//   node src/families/stats/cli.ts registry-sync [--dry-run]     this family's registry fragment only (disposable databases;
//                                                                the shared registry is synced by the main CLI after integration)
//
// Environment: EVIDENCE_EXPORT_STATS_DIR (private artifact root outside the repository), EVIDENCE_WAREHOUSE_QUERY_ARGV
// (export only), EVIDENCE_INGEST_DB_URL (load only). None of them is ever printed.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registryPayload, validateSourcesFile } from "../../../../supabase/functions/_shared/registry.ts";
import type { Json } from "../../../../supabase/functions/_shared/types.ts";
import { fragmentFile } from "./registry_fragment.ts";
import { artifactRoot, openArtifact, readObservations } from "./artifact.ts";
import { exportSource } from "./exporter.ts";
import { planFor, STATS_SOURCES, type StatsSourcePlan } from "./routes.ts";
import { commandRunner, queryArgv } from "./upstream.ts";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function selected(name: string | undefined, filter: (plan: StatsSourcePlan) => boolean = () => true): StatsSourcePlan[] {
  if (!name) throw new Error("name a source id, or `all`");
  return name === "all" ? STATS_SOURCES.filter(filter) : [planFor(name)];
}

async function main(argv: string[]): Promise<number> {
  const [command, target, ...rest] = argv;
  if (command === "plan") {
    console.log(JSON.stringify(STATS_SOURCES.map((s) => ({ source_id: s.source_id, products: s.products.map((p) => p.product_id), route: s.route, incremental: s.incremental })), null, 2));
    return 0;
  }
  if (command === "registry-sync") {
    const file = fragmentFile();
    const problems = validateSourcesFile(file);
    if (problems.length) throw new Error("registry fragment is invalid: " + problems.join("; "));
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const rights = JSON.parse(await readFile(join(repo, "catalogue/rights-register.json"), "utf-8")) as { [key: string]: Json }[];
    const payload = await registryPayload(file, rights);
    if (argv.includes("--dry-run")) {
      console.log(JSON.stringify({ dry_run: true, sources: file.sources.map((s) => s.source_id) }, null, 2));
      return 0;
    }
    const { connectLoader } = await import("./loader.ts");
    const db = await connectLoader(process.env);
    try {
      console.log(JSON.stringify({ synced: await db.syncRegistry(payload) }, null, 2));
    } finally {
      await db.close();
    }
    return 0;
  }
  const root = await artifactRoot(process.env);
  const out: unknown[] = [];
  if (command === "export") {
    const run = commandRunner(queryArgv(process.env));
    for (const plan of selected(target)) {
      const manifest = await exportSource(plan, run, root, (message) => console.error(message));
      out.push({ source_id: plan.source_id, counts: manifest.counts, reconciliation: manifest.reconciliation, findings: manifest.findings, files: manifest.files.length });
    }
  } else if (command === "verify") {
    for (const plan of selected(target)) {
      const artifact = await openArtifact(root, plan.source_id);
      let rows = 0;
      for (const file of artifact.observationFiles) for await (const row of readObservations(artifact, file)) rows += row ? 1 : 0;
      if (rows !== artifact.manifest.counts.observations) throw new Error(`${plan.source_id}: observation rows differ from the manifest`);
      out.push({ source_id: plan.source_id, artifact_digest: artifact.digest, observations: rows, meta_rows: artifact.meta.length, verified: true });
    }
  } else if (command === "fetch") {
    const { fetchSource } = await import("./live.ts");
    for (const plan of selected(target, (p) => p.incremental !== "none")) out.push(await fetchSource(plan, root, { log: (message: string) => console.error(message) }));
  } else if (command === "load") {
    const { loadSource, connectLoader } = await import("./loader.ts");
    const dryRun = rest.includes("--dry-run") || target === "--dry-run";
    const db = dryRun ? null : await connectLoader(process.env);
    try {
      // --fresh loads the artifact written by `fetch` (kept beside, never over, the backfill artifact).
      const from = rest.includes("--fresh") ? join(root, "fresh") : root;
      for (const plan of selected(target)) out.push(await loadSource(plan, await openArtifact(from, plan.source_id), db, { dryRun, log: (message: string) => console.error(message) }));
    } finally {
      await db?.close();
    }
  } else {
    throw new Error("commands: plan | export | fetch | verify | load");
  }
  const receiptFile = flag(rest, "--receipt");
  if (receiptFile) await writeFile(resolve(process.cwd(), receiptFile), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error("error: " + String(error instanceof Error ? error.message : error).replace(/postgres(?:ql)?:\/\/\S+/g, "postgres://[redacted]"));
    process.exit(1);
  },
);
