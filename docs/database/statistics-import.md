# Statistics import (P11, P12, P18, P19, P20, P21, P22, P23)

> **Status: built and verified on an isolated disposable local database. Not hosted, not published, not reviewed.** Every rights row is pending and the release gates are closed, so the public projections return no statistics row. A loaded row is not a published row. Figures below are counts of what was read and stored on 20 September 2026 (UTC); they make no claim that a publisher's output is covered completely.

Integration steps for the coordinator: [`ingest/src/families/stats/INTEGRATION.md`](../../ingest/src/families/stats/INTEGRATION.md). Receipts: [`receipts/stats/`](receipts/stats/).

## What was loaded

Two routes lead into the store and both write the same typed artifact, which one loader reads:

- **Backfill**: a read-only export of the upstream research collection (named `SELECT` statements only; no write, no stored original record, no captured body).
- **Incremental**: a fresh anonymous fetch of the publisher's own file or listing, where that is feasible.

| Product | Source id | Observations | Catalogue entries (versions) | Route | Incremental route |
|---|---|---:|---:|---|---|
| P11 Health New Zealand | `stats_healthnz_data` | 44 | 49 (49) | operational | listing page only |
| P12 MSD | `stats_msd_benefits` | 903 | 26 (27) | operational | listing page only |
| P18 Reserve Bank | `stats_rbnz_catalogue` | 0: catalogue only | 18 (18) | catalogue only | public catalogue API |
| P19 2018 Census | `stats_nz_census_2018_highlights` | 4,966 | 0 | dedicated census | none (closed release, ZIP) |
| P20 Stats NZ CSV listing | `stats_nz_csv_catalogue` | 0: catalogue only | 128 (128) | catalogue only | listing page |
| P21 2023 Census | `stats_nz_census_2023` | 37,689 | 757 (757) product-finder entries | operational | none (workbooks) |
| P22 Stats NZ selected series | `stats_nz_selected_series` | 55,428 | 0 | operational | newest release CSV |
| P22, further release files | `stats_nz_release_series` | 234,325 | 0 | dedicated series | none (each file is one named release) |
| P23 Tenancy Services | `stats_tenancy_rental_bonds` | 57,888 | 4 (4) | operational | regional monthly CSV |
| none: history | `stats_nz_census_2013_meshblock` | 882,180 | 0 | dedicated census | none (closed release, ZIP) |
| **Total** | 10 sources | **1,273,423** | **982 (983)** | | |

The 24-product catalogue lists 93, 929, 18, 877, 128, 37,689, 55,428 and 57,892 records for these eight products. Seven of those figures are reproduced exactly by observations plus catalogue entry keys (44 + 49, 903 + 26, 18, 128, 37,689, 55,428, 57,888 + 4). **P19 is the exception, on purpose**: the catalogue's 877 is the operational copy of six CSV members; the store holds all 4,966 observations of the same file from the dedicated route. See the next section.

## One route per file; overlapping counts are never added

Upstream holds statistics twice: in dedicated census and series tables, and as operational records of the general refresh. Where both hold the same publisher file, one route is imported and the other is only counted.

- **P19.** The operational route holds 877 record ids (1,754 stored rows over two collection runs). The dedicated census route holds 4,966 observations. Both name the same ZIP by SHA-256. All 877 operational rows were matched one to one in the dedicated route on member, row, measure and value, so the 877 are a subset of the 4,966. The dedicated route is imported; adding the two would count 877 cells twice.
- **Dedicated series.** Each of nine release files was collected twice (byte-identical, same SHA-256, same observation keys). One capture is imported (234,325 observations); `capture_count = 2` records the other. The 468,650 stored rows are not 468,650 observations.
- **P22.** The operational selected-series file and the dedicated release files are different files with different vintages. Both are loaded, as separate datasets and releases. A series that appears in two vintages has two sets of observations, one per release; they are never merged or summed.
- **P20 listing.** 374 stored versions over six collection runs fold into 128 entry versions: the other 246 were re-collections with identical allowlisted content, kept as first/last observed times and an observation count.

`stat_route_reconciliation` holds one row per dataset (18 rows) with the counts of every route side by side. The database refuses an observation whose route differs from the recorded one, and refuses an import that names a different route for a recorded family.

## Reconciliation, source to store

Every load receipt carries both halves: upstream -> artifact (from the exporter) and artifact -> store (measured after the load). All differences are zero or explained; an unexplained difference fails the run.

Value-level check, run independently of the loader (exact decimal sums, upstream read-only session versus the store):

| Dataset | Rows | Sum upstream | Sum in store |
|---|---:|---:|---:|
| Tenancy regional monthly | 57,888 | 262,633,787.132 | 262,633,787.132 |
| MSD national tables | 903 | 17,896,362,081 | 17,896,362,081 |
| Selected series (both datasets, reported rows) | 55,340 | 173,990,778.25630396 | 173,990,778.25630396 |
| 2023 Census (both datasets, reported rows) | 37,459 | 1,129,670,131 | 1,129,670,131.0 |
| 2018 Census highlights | 4,966 | 618,178,365 | 618,178,365 |
| 2013 meshblock history | 882,180 | 419,284,413 | 419,284,413 |
| GDP release file (numeric rows) | 95,725 | 1,178,589,726 | 1,178,589,726 |

The sums are a transport check only. They add unlike units and have no statistical meaning.

A replay of every artifact inserted **0** observations and **0** catalogue versions and reported every row unchanged: 1,273,423 observations inserted by the first pass, 1,273,423 unchanged and 0 conflicts in the second; 983 catalogue versions written, then 0.

The fresh-fetch artifacts were then loaded on top and replayed: 59,983 observations inserted (the August price index vintage), 57,888 unchanged (the byte-identical tenancy file), 0 conflicts, 194 listing entry versions written; the replay wrote nothing. The store then held 1,333,406 observations and 1,177 catalogue entry versions.

## Incremental route: fresh anonymous fetches (20 September 2026)

One run per source through the shared fetch guard (host allowlist, pacing, robots.txt recorded as an advisory, no cookie, key or sign-in). None was blocked or challenged. A block would be recorded as `blocked`, never as zero records.

| Source | Fetched | Result | Compared with the backfill |
|---|---|---|---|
| `stats_rbnz_catalogue` (P18) | public catalogue API | 18 dataset entries | all 18 URLs also in the backfill; robots.txt disallows the API path, recorded as an advisory |
| `stats_nz_csv_catalogue` (P20) | listing page | 120 file entries | all 120 URLs also in the backfill (which holds 128 from earlier collections) |
| `stats_healthnz_data` (P11) | listing page | 26 links | all 26 also in the backfill; robots.txt disallow recorded as an advisory |
| `stats_msd_benefits` (P12) | statistics index | 26 links | all 26 also in the backfill |
| `stats_tenancy_rental_bonds` (P23) | listing page, then the regional monthly CSV | 57,888 observations, 4 links | **the same file** (same SHA-256): all 57,888 identities, values, statuses and periods equal the backfill |
| `stats_nz_selected_series` (P22) | listing page, then the newest selected price indexes CSV (August 2026) | 59,983 observations (59,892 reported, 91 printed `NA`), 237 series | a newer vintage than the backfilled June 2026 file: all 55,284 backfill identities are present; 54,368 carry the same value; 916 differ, all in four seasonally adjusted series the publisher marks `REVISED`; 4,699 identities are new (further series and later months) |

A fresh file is stored as its own release (`file-<first 16 hex of its SHA-256>`). The June and August vintages therefore sit side by side, and the 916 revisions are visible as two values under two releases rather than as one overwritten number. Fresh listing entries use their own key space (`ckan:` / `listing:`) and are matched to backfilled entries by URL, not merged.

## Meaning that is preserved

- **Withheld is not zero.** 2,781 backfilled observations carry no number: `confidential` 2,427, `missing` 294, `suppressed` 30, `flag_marker` 27, `not_applicable` 3. The fresh August price index file adds 91 cells printed `NA` (`missing` 385 in the store after the fresh load, 2,872 withheld rows in all; rows under a withheld status that carry a number: 0). They are stored as null with a status and the publisher's symbol (`..C`, `x`, `NA`, `C`, `S`). The contract, the ingestion function and the table each refuse a number under a withheld status. Published zeros stay zeros: 72,340 of them in the 2013 history alone, identical to the upstream count.
- **Status vocabulary.** `reported`, `provisional` (publisher flag P / Provisional), `suppressed`, `confidential`, `missing`, `not_applicable`, and `flag_marker` for a marker symbol printed in a flag column (27 electorates marked as outside the 5 percent quota tolerance). The publisher's own flag is kept verbatim in `source_status`; a revised figure is `reported` with `source_status = REVISED`.
- **Exact numbers.** Values travel as decimal text into `numeric(38,12)`; the publisher's cell text is kept in `raw_value`. Exponent notation printed by a publisher (`107e3`) is expanded by moving the decimal point. A number with more than 12 fractional digits cannot be held exactly in that column: it is stored as a double beside its verbatim text (583 consumer price index values).
- **Units, period, geography, vintage.** Each series keeps its unit, magnitude, frequency and seasonal adjustment; each observation its period label as printed (period bounds only where the label gives them); each geography its publisher code, name, level and boundary edition; each release its vintage label, file SHA-256 and byte size.
- **Collected-at is not source-updated-at.** `retrieved_at` and `observed_*_at` are collection times. `released_on` exists only with `released_on_basis = publisher_stated_date`: two 2023 Census releases have one. An HTTP `Last-Modified` header is kept verbatim and is not a release date.
- **History.** The 2018 and 2013 census sources are flagged `historical`. The 2013 file carries 2001, 2006 and 2013 values on 2013 boundaries; the publisher's independently rounded national totals stay separate `national_from_<level>` geographies.
- **A listing's page hash is not a file hash.** `file_sha256` is filled for one entry only, the MSD workbook the collection fetched itself.

## A finding about the upstream normaliser

One dedicated release file (rental price indexes, 1,420 rows) uses the column names `SER_REF`, `TIME_REF` and `DATA_VAL`. The upstream normaliser did not recognise them and recorded every row as having no value. Upstream kept the publisher's columns verbatim, so the mapper reads the number, the period and the series reference from the publisher's own columns. All 1,420 rows load as `reported`; `upstream_status` keeps the word `missing` so the difference can be audited.

## What is not covered

- P11: 44 facts, one workbook, one quarter. P12: 43 reviewed national series of one quarterly workbook. That is everything upstream normalised, not everything the publishers print; the other files are catalogue links.
- P18 and P20 are catalogue only. No Reserve Bank time series is imported or implied.
- P21: two workbooks (population and dwelling counts; electoral populations). The 757-entry product finder indexes the rest; the publisher's observation API needs a subscription key and is not used.
- Income and housing-cost tables carry classification codes without labels; four of them print no year column (`period_label = not_stated_in_row`, 972 rows).
- No unattended incremental route exists for P11/P12 facts, P19, P21 or the dedicated release files. Reasons are recorded per source in `routes.ts` and in each source's `blocked_reason`.
