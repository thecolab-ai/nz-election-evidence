#!/usr/bin/env node
// Copies CLI run receipts into docs/database/receipts/ after proving they are safe to publish.
// A receipt may hold counts, hashes, statuses, the manifest and publisher URLs. It is refused if it
// holds anything that looks like a credential, a connection string, a local address, a file location
// or a payload.
//
//   node tools/publish_receipts.ts <directory with *.json receipts> <YYYY-MM-DD>

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN: [RegExp, string][] = [
  [/\/(home|Users|root|var|mnt|srv)\//, "file location"],
  [/postgres(ql)?:\/\//i, "connection string"],
  [/\b(127\.0\.0\.1|localhost|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)\b/, "local or private address"],
  [/password|secret|api[_-]?key|bearer\s|eyJ[A-Za-z0-9_-]{10,}/i, "credential-like text"],
  [/"safe_payload"|"body"\s*:|"html"\s*:/, "payload or body"],
];

export function receiptProblems(text: string): string[] {
  return FORBIDDEN.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
}

export function sanitiseReceipt(raw: { [key: string]: unknown }, note: string): { [key: string]: unknown } {
  const { planned_records_digest_sample: _sample, planned_record_count: _count, ...rest } = raw;
  return { ...rest, receipt_note: note };
}

async function main(argv: string[]): Promise<number> {
  const [from, date] = argv;
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
    console.error("usage: node tools/publish_receipts.ts <receipt directory> <YYYY-MM-DD>");
    return 2;
  }
  const out = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/database/receipts");
  const note = `Real retrieval from the official publisher on ${date} (UTC), written to a disposable local database. Counts, hashes, statuses and publisher URLs only; no payloads or response bodies.`;
  let published = 0;
  for (const name of (await readdir(from)).filter((f) => f.endsWith(".json")).sort()) {
    const text = await readFile(resolve(from, name), "utf-8");
    const problems = receiptProblems(text);
    if (problems.length) {
      console.error(`REFUSED ${name}: ${problems.join(", ")}`);
      return 1;
    }
    await writeFile(resolve(out, `${date}-${name}`), JSON.stringify(sanitiseReceipt(JSON.parse(text), note), null, 2) + "\n");
    published++;
  }
  console.log(`published ${published} receipts`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
