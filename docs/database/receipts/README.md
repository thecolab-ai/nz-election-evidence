# Ingestion receipts

Each file is the sanitised receipt of one real run of `ingest/src/cli.ts`, published by `tools/publish_receipts.ts` (which refuses anything resembling a credential, connection string, local address, file location or payload). Runs were on 20 September 2026 (UTC) against the official publisher, signed in as the scoped worker login, written to a **disposable local database**. No hosted project was touched.

A receipt holds counts, content-hash digests, statuses, the run manifest and the publisher URLs requested. It never holds a payload, a response body, a credential, a file location or a machine name. Response bodies are represented by their SHA-256 only.

| Receipt | What it shows |
|---|---|
| `*-nz_parliament_mp_directory.run1/2` | 122 listing rows retrieved; the second run inserted **0** new versions and 122 new sightings (idempotent replay). |
| `*-nz_parliament_current_bills.run1/2` | 93 bills over 2 pages (paginated POST); replay inserted 0 versions. |
| `*-nz_government_releases_feed.run1/2` | 10 feed items, titles and links only; replay inserted 0 versions. |
| `*-baseline_2023_candidacies_export.import1/2` | Import of the verified 963-row 2023 candidacy product into the **local disposable database** (rights pending, publication off). Input matched the pinned checksum and the upstream manifest. 963 stored, 0 rejected, 0 skipped; 495 electorate and 468 list; the second import inserted **0** new versions. `input_findings` reports what was not resolved: 468 list rows and 495 electorate rows carried an upstream default zero that was dropped rather than stored, and one electorate (Port Waikato) where every candidate's source-reported figure is 0 - kept as published, with no inference about why. |
| `*-ec_*.run1` | The Electoral Commission sites answered this host with a bot-challenge page. Recorded as `blocked` / `publisher_challenge`. **Zero records seen is not zero records in existence**; nothing was tombstoned and no count is implied. |
| `*-nz_parliament_written_questions.run1` | The publisher's new questions site is reachable; status `parser_not_enabled`, nothing imported, no count implied. (An earlier run against the former URL was refused by the fetch guard with `host_denied`, because it redirected to a host that was not yet on the allowlist; the allowlist was then updated in version control.) |

### After the PR 8 review fixes (run3 / run4 / import3 / import4, same day, rebuilt database)

The fetch guard now reads robots.txt before anything else on a host, paces requests, and refuses endpoints with no established basis for automated access. The earlier `run1` / `run2` receipts above are kept as history; for the MP directory and bills they record retrievals made **before** those checks existed, and neither source may run now.

| Receipt | What it shows |
|---|---|
| `*-publisher-access-checks.json` | For each live source, what robots.txt and the rights register's terms page looked like to this client: URL, status, size, body hash, finding. **Provenance only: not a legal reading, not a permission, not a rights review.** Findings: MP directory host disallows all automated clients; bills, questions, Beehive, elections.nz and vote.nz robots allow the path; the 2023 results host refuses robots.txt itself (403), so access is not assumed; the Parliament terms page is on the host that disallows automated clients, so it was **not fetched**; no terms URL is recorded for the Beehive or Electoral Commission rows (their copyright pages answered this client with a bot challenge), so none was entered. |
| `*-nz_government_releases_feed.run3/4` | robots.txt, then the feed: 10 items; replay inserted **0** versions. The only source that ran. |
| `*-nz_parliament_mp_directory.run3` | `blocked` / `publisher_robots_disallowed`. One request (robots.txt); the listing was never requested. Blocked is not "no members". |
| `*-nz_parliament_current_bills.run3` | `blocked` / `access_basis_not_established` with **no request at all**: the endpoint is undocumented. Blocked is not "no bills". |
| `*-ec_2023_official_results.run3` | `blocked` / `publisher_robots_unavailable`. |
| other `*-ec_*.run3` | robots.txt readable and permissive; the page itself answered with a bot challenge: `blocked` / `publisher_challenge`. |
| `*-baseline_2023_candidacies_export.import3/4` | Same pinned input on the rebuilt database: 963 stored, 0 rejected; replay inserted **0** versions. |

These receipts prove the adapters, parsers and ledger work against live publishers. They are **not** a coverage claim: see [source-reconciliation.md](../source-reconciliation.md).
