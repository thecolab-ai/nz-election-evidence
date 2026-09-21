#!/usr/bin/env node
// Election family export.
//
//   EVIDENCE_WAREHOUSE_QUERY_ARGV='[...]' node src/families/election/export_cli.ts --out <private directory>
//
// Reads the warehouse read-only, writes owner-only export files outside the repository and prints the
// reconciliation (counts, hashes and checks only: no row content, no locations).

import { buildExport, writeExport } from "./exporter.ts";
import { commandRunner, warehouseArgv } from "./warehouse.ts";

async function main(argv: string[]): Promise<number> {
  const out = argv[argv.indexOf("--out") + 1];
  if (!argv.includes("--out") || !out) throw new Error("usage: export_cli.ts --out <private directory outside the repository>");
  const result = await buildExport(commandRunner(warehouseArgv(process.env)));
  const names = await writeExport(result, out);
  console.log(JSON.stringify({ written: names, files: result.manifest.files, reconciliation: result.manifest.reconciliation, cross_product: result.manifest.cross_product, all_checks_ok: result.manifest.all_checks_ok }, null, 2));
  return result.manifest.all_checks_ok ? 0 : 3;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
  console.error("error: " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
