#!/usr/bin/env node
// Copies statistics load/export/fetch receipts into docs/database/receipts/stats/ after proving they are safe to
// publish, with the same refusal rules as tools/publish_receipts.ts (no credential, connection string, local
// address, file location or payload). A receipt holds counts, hashes, statuses and publisher URLs only.
//
//   node src/families/stats/publish_receipts.ts <directory with *.json receipts> <YYYY-MM-DD>

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { receiptProblems } from "../../../../tools/publish_receipts.ts";

async function main(argv: string[]): Promise<number> {
  const [from, date] = argv;
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
    console.error("usage: node src/families/stats/publish_receipts.ts <receipt directory> <YYYY-MM-DD>");
    return 2;
  }
  const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docs/database/receipts/stats");
  await mkdir(out, { recursive: true });
  const note = `Statistics family, ${date} (UTC). Read-only upstream export or fresh anonymous fetch, loaded into an isolated disposable local database. Nothing hosted was written. Counts, hashes, statuses and publisher URLs only.`;
  let published = 0;
  for (const name of (await readdir(from)).filter((f) => f.endsWith(".json")).sort()) {
    const text = await readFile(resolve(from, name), "utf-8");
    const problems = receiptProblems(text);
    if (problems.length) {
      console.error(`REFUSED ${name}: ${problems.join(", ")}`);
      return 1;
    }
    const parsed = JSON.parse(text) as unknown;
    const receipts = Array.isArray(parsed) ? parsed : [parsed];
    await writeFile(resolve(out, `${date}-${name}`), JSON.stringify({ receipt_note: note, receipts }, null, 2) + "\n");
    published++;
  }
  console.log(`published ${published} receipts`);
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
  console.error("error: " + String(error instanceof Error ? error.message : error));
  process.exit(1);
});
