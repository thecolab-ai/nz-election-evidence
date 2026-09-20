# Ingestion receipts

Each file is the sanitised receipt of one real run of `ingest/src/cli.ts`, published by `tools/publish_receipts.ts` (which refuses anything resembling a credential, connection string, local address, file location or payload). Runs were on 20 September 2026 (UTC) against the official publisher, signed in as the scoped worker login, written to a **disposable local database**. No hosted project was touched.

A receipt holds counts, content-hash digests, statuses, the run manifest and the publisher URLs requested. It never holds a payload, a response body, a credential, a file location or a machine name. Response bodies are represented by their SHA-256 only.

| Receipt | What it shows |
|---|---|
| `*-nz_parliament_mp_directory.run1/2` | 122 listing rows retrieved; the second run inserted **0** new versions and 122 new sightings (idempotent replay). |
| `*-nz_parliament_current_bills.run1/2` | 93 bills over 2 pages (paginated POST); replay inserted 0 versions. |
| `*-nz_government_releases_feed.run1/2` | 10 feed items, titles and links only; replay inserted 0 versions. |
| `*-ec_*.run1` | The Electoral Commission sites answered this host with a bot-challenge page. Recorded as `blocked` / `publisher_challenge`. **Zero records seen is not zero records in existence**; nothing was tombstoned and no count is implied. |
| `*-nz_parliament_written_questions.run1` | The publisher's new questions site is reachable; status `parser_not_enabled`, nothing imported, no count implied. (An earlier run against the former URL was refused by the fetch guard with `host_denied`, because it redirected to a host that was not yet on the allowlist; the allowlist was then updated in version control.) |

These receipts prove the adapters, parsers and ledger work against live publishers. They are **not** a coverage claim: see [source-reconciliation.md](../source-reconciliation.md).
