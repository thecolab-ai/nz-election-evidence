# Source reconciliation

**This document makes no claim of complete coverage.** It enumerates, source by source, what this branch can ingest today, what it has actually retrieved (on a disposable local database), and what remains outside it. A count here is a dated observation, never a completeness certificate. Unknown is not zero; an unavailable endpoint is not an empty source.

## What the upstream audit counts mean

The project's earlier research warehouse was audited before this work. Those figures are inputs to reconcile, not totals to reproduce:

| Upstream figure | Meaning | How this store treats it |
|---|---|---|
| 351,710 current operational records / 391,024 content versions, across 24 source IDs and 21 registry products | The **operational** table only. It is **not the whole warehouse**. | Published catalogue total (24 products, P01–P24). Imported here: **none yet**. |
| 887,146 census observation rows and 468,650 series observation rows in dedicated statistics tables | **Overlap** the operational statistics products. | Must be reconciled per observation family and imported through **one** route. `stat_route_reconciliation` plus an insert trigger make a second route fail. Never added to the operational total. |
| 495 electorate + 468 list candidacies (2023) in dedicated tables, versus a 486-row operational roster | The dedicated tables are more complete. | The export contract `baseline_2023_candidacies_export` targets the dedicated rows; the 486-row roster is superseded, not added. |
| 122 members observed on 11 June 2026 | A dated snapshot, now stale. | Replaced by a fresh retrieval from the official directory (122 rows on 20 September 2026). The June snapshot is not imported as current. |
| 33 historical party identities | Historical labels, **not** the current register. | Not imported as registrations. The official register could not be reached from the build host, so current registration is unknown here. |

The 24 upstream source IDs, the 21 registry products and the 24 public catalogue products are three different identifier spaces. `catalogue_product_map` records each mapping explicitly with a note; equality is never assumed.

## Live adapters (proven against the publisher on 2026-09-20)

| Source | Publisher endpoint | Retrieved | Snapshot semantics | Catalogue product | Not covered |
|---|---|---|---|---|---|
| `nz_parliament_mp_directory` | Official members listing | 122 rows: 71 electorate, 51 list; 7 distinct party labels | Complete snapshot | P10 | Roles and portfolios (profile pages not fetched); service start/end dates (not stated by the listing); any vacancy event. Seats in the House is a different number from members listed and is not derived. |
| `nz_parliament_current_bills` | Bills search API, 2 pages | 93 current bills, metadata only | Complete snapshot | P03 | Bill text, versions, stages history, terminated or enacted bills; P02 is a different product. |
| `nz_government_releases_feed` | Releases RSS | 10 items (the feed window), title + link | Append-only feed | P01 | The 4,735-record history behind P01 (needs an export import). Summary text and release bodies are never stored. |

Receipts: [receipts/](receipts/README.md).

## Official sources that were unavailable or not parsed

| Source | Scope | Result on 2026-09-20 | Consequence |
|---|---|---|---|
| `ec_2026_nominations` | 2026 primary | Bot-challenge page | **No official nominations loaded. The number of 2026 candidates is unknown, not zero.** Party announcements are a different status and are not collected. |
| `ec_register_of_political_parties` | 2026 primary | Bot-challenge page | Current registered parties unknown here. |
| `ec_2023_official_results` | 2023 baseline | Bot-challenge page (HTTP 403) | Baseline rows must arrive through the reviewed export import. |
| `ec_party_finance_returns` | 2025 finance | Bot-challenge page | Return status unknown here. Donor identities are never collected in any case. |
| `nz_parliament_written_questions` | Current Parliament | Reachable after the allowlist was updated for the publisher's new host; no parser enabled | Nothing imported; no count implied. |

The project does not work around publisher blocks (R6). Options are an approved publisher API or data download, written permission, or the reviewed export route.

## Catalogue products with no route into this store yet

P02, P04 (contract defined, export not supplied), P05, P06, P07, P08, P09, P11, P12, P13, P14, P15, P16, P17, P18, P19, P20, P21, P22, P23, P24. For each of these the tables and inspector views may exist, but **zero rows have been imported** and the explorer will show an empty state, which is not evidence of absence. Each needs: (1) an export contract with a field allowlist, (2) a reconciliation note against overlapping upstream tables, (3) the exporter's stated row count, (4) an import receipt. Forcing an import to match an upstream count is explicitly not a goal; omissions are itemised instead.

## Research handoff received during this work

A separate research note (20 September 2026) reports: 2026 boundaries of 71 electorates (64 general, 7 Māori) rather than the 72 used in 2023; nominations and party lists closing at noon on 8 October 2026; 17 registered parties; and 122 members listed with one vacancy attributed to a specific electorate. **None of this could be verified from the build host** (Electoral Commission sites were unavailable), so none of it is seeded. The schema is compatible with it: boundary editions are versioned, no electorate count is hardcoded, current members are never attached to 2026 boundaries, and the nominations source already carries an explicit not-yet-published state.

## Rights

All 19 publisher rights rows are mirrored from `catalogue/rights-register.json` and remain **pending / link-only**. Ingesting into the private store changes none of them. The release function refuses any item whose rights row is not approved, even with every gate open (tested).
