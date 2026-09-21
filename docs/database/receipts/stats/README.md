# Statistics family receipts

Published by `ingest/src/families/stats/publish_receipts.ts`, which applies the same refusal rules as `tools/publish_receipts.ts`: a receipt may hold counts, hashes, statuses and publisher URLs, and is refused if it holds anything that looks like a credential, a connection string, a local address, a file location or a payload.

All runs were on 20 September 2026 (UTC) against an **isolated disposable local database**, rebuilt from the migrations immediately before the first load. Nothing hosted was written. Run ids belong to that disposable database. Rights rows are pending and the release gates are closed, so none of these rows is published.

| Receipt | What it shows |
|---|---|
| `*-export-<source>.json` | Backfill export: the read-only upstream recipe mapped into the private artifact. Counts per kind and status, and the upstream -> artifact reconciliation with every difference explained. |
| `*-verify-all.json` | Every artifact re-hashed against its manifest and every row re-validated against the typed contract. |
| `*-load-<source>.json` | First load into the rebuilt database: both reconciliation halves (upstream -> artifact, artifact -> store), per-release counts, the check that no withheld row carries a number. |
| `*-replay-<source>.json` | The same artifact loaded again: **0** observations inserted, **0** catalogue versions written, every row unchanged. |
| `*-fetch-<source>.json` | Incremental route: one fresh anonymous fetch of the publisher's page or file through the shared fetch guard. Requested URLs, outcomes, sizes and body hashes; robots.txt advisories are recorded, not vetoes. No page or file body is kept. |
| `*-fresh-load-<source>.json` | The fresh-fetch artifact loaded on top of the backfill. Tenancy: the publisher's file is byte-identical to the backfilled one (same SHA-256), so every one of its 57,888 rows is unchanged. Selected price indexes: a newer file, stored as its own release vintage beside the earlier one; nothing is merged or overwritten. Listings: entries whose content is new become new versions. |
| `*-fresh-replay-<source>.json` | Each fresh artifact loaded again: 0 observations inserted, 0 catalogue versions written. |
| `*-registry-sync.json` | The family's ten sources and their pending rights rows written to the disposable database before the first load. |

The receipts are one ordered pass: export of all ten sources, fresh fetch of the two publisher files, verify, rebuild of the disposable database, load, replay, fresh load, fresh replay. Every step ended with exit status 0. The four listing-page fetch receipts are from a run earlier the same day; their artifacts hold catalogue entries only, and the loader re-hashed every file of them against its manifest before loading in this pass.

A blocked publisher would appear here as `status: "blocked"` with the outcome. It would be an availability fact, never a count of zero. On this date none of the six fresh fetches was blocked or challenged.
