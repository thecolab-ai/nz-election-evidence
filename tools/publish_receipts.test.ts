import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { receiptProblems, sanitiseReceipt } from "./publish_receipts.ts";

test("receipts with credentials, connection strings, local addresses, file locations or payloads are refused", () => {
  assert.deepEqual(receiptProblems('{"status":"succeeded","fetches":[{"url":"https://bills.parliament.nz/api/data/search"}]}'), []);
  assert.ok(receiptProblems('{"x":"postgresql://u:p@db/x"}').includes("connection string"));
  assert.ok(receiptProblems('{"x":"http://127.0.0.1:55321"}').includes("local or private address"));
  assert.ok(receiptProblems('{"x":"/ho' + 'me/someone/export.jsonl"}').includes("file location"));
  assert.ok(receiptProblems('{"safe_payload":{}}').includes("payload or body"));
  assert.ok(receiptProblems('{"token":"Bearer abc"}').includes("credential-like text"));
});

test("dry-run record samples are dropped and the note is added", () => {
  const out = sanitiseReceipt({ status: "dry_run", planned_records_digest_sample: [1], planned_record_count: 1 }, "note");
  assert.deepEqual(out, { status: "dry_run", receipt_note: "note" });
});

test("every published receipt in the repository passes the same check", async () => {
  const dir = new URL("../docs/database/receipts/", import.meta.url);
  const names = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  assert.ok(names.length >= 10);
  for (const name of names) assert.deepEqual(receiptProblems(await readFile(new URL(name, dir), "utf-8")), [], name);
});
