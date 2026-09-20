# Statistics import family: integration instructions

Products owned: **P11** Health New Zealand, **P12** MSD, **P18** Reserve Bank (catalogue only), **P19** 2018 Census, **P20** Stats NZ CSV listing (catalogue only), **P21** 2023 Census, **P22** Stats NZ selected series, **P23** Tenancy Services rental bonds.

Status: built and verified on an **isolated disposable database**. Nothing hosted was written, nothing was pushed or deployed, no shared local stack was reset. Rights rows stay pending and the release gates stay closed: a loaded row is not a published row.

## What is in this family

| File | Role |
|---|---|
| `contract.ts` | The typed, closed artifact contract. Every key is named; `validateRow` refuses anything else. Decimal text end to end; withheld is null with a status, never zero. |
| `routes.ts` | One authoritative upstream route per source, the overlap that is counted but not imported, and the incremental route of each product. |
| `upstream.ts` | The read-only export recipe: ten named `SELECT` statements and a guard that refuses anything else. The query command is an operator-supplied environment value; nothing about the upstream host enters the repository. |
| `mappers.ts` | Pure mappers from upstream rows to contract rows, with a closed status vocabulary. Unknown status, a number under a withheld status, two rows of one identity or a key with two definitions fail the export. |
| `exporter.ts` | Backfill: recipe -> mappers -> private artifact, reconciled against upstream counts before it reports success. |
| `live.ts`, `live_parsers.ts` | Incremental: a fresh anonymous fetch through the shared fetch guard -> the same artifact format, written beside (never over) the backfill artifact. |
| `artifact.ts` | Private artifact directory outside the repository (0700/0600), streamed chunk files, manifest with per-file SHA-256 and row counts. The reader re-hashes every file. |
| `loader.ts` | The only writer. Preflight of every row -> lease and run ledger -> meta -> checkpointed batches -> destination counts -> reconciliation -> finish. |
| `registry_fragment.ts` | This family's ten `SourceConfig` entries. |
| `cli.ts` | `plan`, `export`, `fetch`, `verify`, `load`, `registry-sync`. |
| `publish_receipts.ts` | Copies load receipts into `docs/database/receipts/stats/` after the shared receipt safety check. |
| `supabase/migrations/20260921030100_stats_import.sql` | Additive migration (prefix `2026092103`). |
| `supabase/tests/110_stats_import.test.sql` | pgTAP: replay, conflict, withheld-never-a-number, route switch, release repointing, worker cannot edit history. |
| `supabase/tests/115_stats_table_boundary.test.sql` | pgTAP: the tables enforce the rules against **plain DML by the worker role** (the functions are `SECURITY INVOKER`, so the worker holds table privileges): ownership by running leased run, text guard, append-only, one-way columns, catalogue currency, true summaries, guards out of the worker's reach. See `docs/database/unified-loaders.md` section 2. |
| `ingest/test/stats_*.test.ts` | Offline tests; run alone with `node --test test/stats_contract.test.ts test/stats_loader.test.ts test/stats_live.test.ts`. |

No shared file was edited: not `sources.config.json`, `registry.ts`, `runner.ts`, `types.ts`, `db.ts`, `http.ts`, `ingest/src/cli.ts`, nor any existing migration or test.

## Coordinator steps

1. **Migration order.** `20260921030100_stats_import.sql` depends only on the merged `main` migrations (through `20260920001400`). It ends with `classify_public_columns()` and `rebuild_exposed_views()`. If another family's migration also changes exposed objects, keep each family's two calls, or run both functions once after the last family migration; they are idempotent.
2. **Generated types.** The migration adds two base views (`stat_releases`, `stat_catalogue_entries`), one table, and appends columns to `evidence_views.stat_series` and `evidence_views.stat_observations`. After all family migrations are in place run `npm run types:generate` in `web/` once and commit the result. It is deliberately NOT regenerated on this branch: three family branches regenerating the same file would conflict.
3. **Registry.** Append `STATS_REGISTRY_FRAGMENT` (ten sources) to `sources` and `STATS_REGISTRY_PRODUCT` to `registry_products` in `supabase/functions/_shared/sources.config.json`, then bump `config_version`. To produce the JSON: `node -e 'import("./src/families/stats/registry_fragment.ts").then(m => console.log(JSON.stringify(m.fragmentFile(), null, 2)))'` from `ingest/`. The fragment passes `validateSourcesFile` (tested). Every source is `enabled: false` with its reason; none is schedulable, by design (file sizes exceed the Edge Function budget).
   - The six sources with a fresh-fetch route use `adapter_name: "stats_family_fetch"`. That name is not in the shared `LIVE_ADAPTERS` map, so `cli.ts run <source>` answers "adapter not found". That is intended: these sources run through the family CLI. If the coordinator prefers, register a stub that says so.
   - `registry_key` is `statistics` for all ten.
4. **Test wiring.** `ingest/package.json` already globs `test/*.test.ts`, so the three `stats_*.test.ts` files run with `npm test`. `supabase test db` picks up `110_stats_import.test.sql`.
5. **Remote load** (after migrations and registry sync, with the worker login; every command prints a receipt and never a connection value):

   ```sh
   cd ingest
   # private inputs, named by environment only
   export EVIDENCE_EXPORT_STATS_DIR=<private directory outside the repository>
   export EVIDENCE_WAREHOUSE_QUERY_ARGV='["<read-only query command>"]'   # export step only
   node src/families/stats/cli.ts export all          # read-only upstream export -> artifacts (about 1 GB, 0600)
   node src/families/stats/cli.ts verify all          # re-hash and re-validate every row
   node src/families/stats/cli.ts load all --dry-run  # preflight only, no connection
   node src/families/stats/cli.ts load all --receipt <file>
   node src/families/stats/cli.ts load all --receipt <file>   # replay: must report inserted 0
   ```

   The query command is any program that reads ONE `SELECT ... FORMAT JSONEachRow` statement on standard input, runs it against the upstream collection **with a read-only session**, and writes one JSON object per line. The exporter refuses every statement that is not a single read-only `SELECT` before it starts the command, and never names a stored original record, a captured body or a location on a disk.

   The existing artifacts produced on 2026-09-20 can be loaded as they are (their manifests pin every file hash); re-exporting reproduces them byte for byte while upstream is unchanged.
6. **Order and size.** Load small sources first; `stats_nz_census_2013_meshblock` is 882,180 observations and 49,010 geographies (about 45 files of 20,000 rows, 5,000-row batches). It answers no catalogue product and is labelled `historical`; leave it out of a first hosted load if storage is a concern (`load <source_id>` per source). Each batch is one autocommit function call with no session state, so a transaction-mode pooler is fine. A stopped run resumes from its checkpoint; a replay inserts nothing.
7. **Incremental.** `cli.ts fetch <source_id>` then `cli.ts load <source_id> --fresh`. A fresh file is its own release vintage (`file-<first 16 hex of its SHA-256>`); it never overwrites an earlier vintage. A series whose unit wording differs from the stored definition is refused, not overwritten, and needs a person.

## Route decisions (never summed)

| Source | Product | Route imported | Overlap counted, not imported |
|---|---|---|---|
| `stats_nz_census_2018_highlights` | P19 | dedicated census: **4,966** observations (all CSV members of the file) | operational: 877 record ids (1,754 stored rows over two runs), the SAME file by SHA-256. All 877 were matched one to one in the dedicated route (member, row, measure, value). 877 is a subset of 4,966. |
| `stats_nz_census_2023` | P21 | operational: **37,689** | none (the dedicated census tables hold no 2023 observation; their 757-row product finder is loaded as catalogue entries) |
| `stats_nz_selected_series` | P22 | operational: **55,428** | none: the dedicated series tables hold different files |
| `stats_nz_release_series` | P22 (further files) | dedicated series: **234,325** (one capture of each of 9 files) | the second capture of each byte-identical file: 234,325 stored rows, counted in `capture_count`, not imported |
| `stats_tenancy_rental_bonds` | P23 | operational: **57,888** | none |
| `stats_msd_benefits` | P12 | operational: **903** | none |
| `stats_healthnz_data` | P11 | operational: **44** | none |
| `stats_nz_census_2013_meshblock` | none (history) | dedicated census: **882,180** | none |

`stat_route_reconciliation` holds one row per dataset with both counts side by side. The database refuses an observation whose route differs from the recorded one, and refuses an import that tries to switch a route.

## Semantics that must survive integration

- **Collected-at is not source-updated-at.** `stat_releases.retrieved_at` and `stat_catalogue_entries.observed_*_at` are collection times. `released_on` is set only with `released_on_basis = 'publisher_stated_date'` (a table constraint). An HTTP `Last-Modified` header is kept verbatim in `publisher_last_modified` and is not a release date.
- **Withheld is not zero.** `value_status` in (`suppressed`, `confidential`, `missing`, `not_applicable`, `flag_marker`) carries no number; the contract, the function and the table each enforce it. A published zero stays `reported` with value 0.
- **Exact numbers.** Values travel as decimal text into `numeric(38,12)`. The publisher's cell text is kept in `raw_value` where upstream kept it. The upstream census tables stored binary doubles and no cell text: those values (whole-number counts) are written from the double's shortest exact decimal form and `raw_value` is null.
- **A listing's page hash is not a file hash.** Upstream listing records carry the hash of the listing page. `file_sha256` is filled only where the collection fetched the file itself (one MSD workbook).
- **Catalogue only stays catalogue.** P18 and P20 have no dataset, series or observation, and `stat_catalogue_entries.facts_asserted` is constrained to false.
- **The content hash covers what the publisher printed, not how it was read.** Identity, period, value, raw text, value status, publisher flag, symbol and qualifiers are hashed; the upstream status word, the locator wording and the parse status are not. The same publisher cell therefore hashes the same through the backfill and through a fresh fetch: a re-fetch of a byte-identical file reports every row unchanged, and a conflict always means the published content differs under one release key.
- **Geography schemes are source-scoped** (`<source_id>:<level>` plus the publisher's boundary edition). The same place in two publishers' files is two rows until a dated crosswalk says otherwise. Where a file prints a name and no code, the name is the code and `code_basis` says so.

## Remaining real blockers

1. **P11 and P12 facts have no unattended incremental route.** Both come from workbooks whose cell mapping was reviewed by hand upstream for one release. The listing pages are fetched fresh; a new workbook needs that review again. The shared fetch client also returns text only, so a workbook cannot be read through it.
2. **P19, P21 and the 2013 history have no incremental route** for the same binary-format reason (ZIP and workbook files). P19 and the 2013 file are closed historical releases; P21's publisher observation API answers 401 without a subscription key and is not used.
3. **P11 holds 44 facts from one workbook and one quarter; P12 holds 43 reviewed national series.** That is everything upstream normalised, not everything the publishers print. The catalogue entries list the other files as links only.
4. **Income and housing-cost tables** (4,364 observations in `stats_nz_release_series`) carry the publisher's classification codes without labels: the release file has no code list. Four of its tables print no year column; those rows use the period label `not_stated_in_row`.
5. **Rights**: every rights row is pending, so projections show link-tier columns only. The upstream collection recorded the publisher's Creative Commons footer as an unverified note; it is carried in `coverage_note` as unverified and is not a rights decision.
6. **Generated web types** are not regenerated on this branch (step 2).
