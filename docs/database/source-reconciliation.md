# Source reconciliation

> **Status: NOT complete, NOT released, NOT security signed off.** Independent reviews of `6b8218e` and `b761023` both returned **NO-GO**; this revision addresses their bounded findings. A separate security re-review was interrupted and is **incomplete**, so no security sign-off exists or is claimed. The PR 8 review findings are dispositioned in [pr8-review-disposition.md](pr8-review-disposition.md). Source completeness is partial: of the **24** catalogue products, **3** have a live adapter (P01 feed window only, P03, P10) all three running again under the owner's collection policy of 2026-09-20 (public unauthenticated endpoints only; robots.txt and undocumented status are recorded signals, not vetoes; no publisher permission is claimed), **1** (P04, the 2023 candidacy product) imports through a pinned export contract on a local disposable database only, and **20 have no route into the store at all**. Nothing has been pushed, applied to a hosted project, scheduled, deployed or published.

| Catalogue products | Count | Which |
|---|---|---|
| Live adapter built and parser-tested | **3** | P01 (feed window only, not the 4,735-record history), P03, P10 |
| …of those, run successfully on 2026-09-20 under the owner's collection policy | **3** | P10 122 rows, P03 93 bills, P01 10 feed items. Signals on record, for a person's decision: P10's host disallows automated clients in robots.txt; P03's endpoint is undocumented; no terms review exists for any of them. |
| Export contract, run on the verified upstream product (local disposable database only; nothing hosted) | **1** | P04: 963 candidacies = 495 electorate + 468 list |
| No route into the store | **20** | P02, P05, P06, P07, P08, P09, P11, P12, P13, P14, P15, P16, P17, P18, P19, P20, P21, P22, P23, P24 |

None of the upstream 351,710 operational records, 391,024 content versions, or the dedicated census and series observations has been imported. The 225 live records retrieved here (122 + 93 + 10) are fresh retrievals, not part of those totals. The 963 candidacy rows come from the dedicated upstream candidacy product, which is separate from (and more complete than) the 486-row operational roster counted inside the 351,710.

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

**Access status under the owner's collection policy (2026-09-20).** After the PR 8 review these sources were briefly held to robots.txt as a veto and to documented endpoints only, which left one of three running. The owner then changed the policy: a read-only page or endpoint served to the anonymous public is eligible; robots.txt, undocumented status and a missing terms review are recorded and reported for a person's decision; anything behind a sign-in, a paywall or a bot challenge is not collected and is never worked around. That is the owner's decision, not the reviewer's ([disposition](pr8-review-disposition.md#owner-collection-policy-2026-09-20-supersedes-parts-of-rows-6-7-and-89)). Results of the fresh runs:

| Source | Fresh result (run5, replay run6) | Endpoint kind | Signals recorded with it |
|---|---|---|---|
| `nz_parliament_mp_directory` | **122 rows**; replay 0 new versions | Public page | **robots.txt disallows the path** (`User-agent: *`, `Disallow: /`), logged on every run as `robots_advisory_disallowed`; terms page retrieved; no person's terms review |
| `nz_parliament_current_bills` | **93 bills, 2 pages**; replay 0 new versions. Anonymous: no `Origin`, `Referer`, cookie or token | **Public undocumented endpoint** (the search API the publisher's public site calls) | robots.txt allows; undocumented, no published terms for the endpoint; terms page retrieved; no terms review |
| `nz_government_releases_feed` | **10 items**; replay 0 new versions | Public feed | robots.txt allows; no terms URL recorded (that page answers with a bot challenge); no terms review |

All three schedules exist and are **inactive**. None of this is a rights approval: every rights row is pending and nothing is published.

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
| `ec_2023_official_results` | 2023 baseline | robots.txt answers HTTP 403 (recorded); the results page answers with a bot challenge (HTTP 403) | Blocked, not worked around. Baseline rows must arrive through the reviewed export import. |
| `ec_party_finance_returns` | 2025 finance | Bot-challenge page | Return status unknown here. Donor identities are never collected in any case. |
| `nz_parliament_written_questions` | Current Parliament | On 2026-09-20 (run5) the publisher's site redirected to a host that is not on the allowlist; the fetch guard refused to follow (`host_denied`). Earlier the same day it was reachable with no parser enabled | Nothing imported; no count implied. The allowlist was not widened. |

The project does not work around publisher blocks: a 401/403, sign-in, paywall or bot challenge is final (R6, and unchanged by the owner's collection policy). Options are an approved publisher API or data download, written permission, or the reviewed export route.

## Catalogue products with no route into this store yet

P02, P04 (contract defined, export not supplied), P05, P06, P07, P08, P09, P11, P12, P13, P14, P15, P16, P17, P18, P19, P20, P21, P22, P23, P24. For each of these the tables and inspector views may exist, but **zero rows have been imported** and the explorer will show an empty state, which is not evidence of absence. Each needs: (1) an export contract with a field allowlist, (2) a reconciliation note against overlapping upstream tables, (3) the exporter's stated row count, (4) an import receipt. Forcing an import to match an upstream count is explicitly not a goal; omissions are itemised instead.

## 2023 candidacy product: what was imported and how

Run on 20 September 2026 against the **local disposable database only**, signed in as the scoped worker. Rights stay pending (link-only) and the release gates stay closed, so none of it is publicly visible.

- **Input control.** The contract is pinned to one validated upstream product: SHA-256 `acb3154d…d82c`, 963 rows, and the upstream manifest must record the same checksum and count. Any other file, count or vocabulary **fails closed before anything is written**; no row is ever skipped. The file and manifest are named by environment variables; their locations never enter the ledger, a receipt or this repository, and the dataset itself is not committed.
- **Vocabulary.** Upstream `party_list` becomes `list`. Upstream `official_result_candidate` and `official_party_list_candidate` become `officially_nominated`, **for this validated official-results product only** (a contract that asserts nomination must be pinned, enforced by config validation). The upstream value is kept beside the normalised one. Unknown values fail closed.
- **Zero versus missing, faithfully.** Upstream stores votes and list rank in columns that cannot be empty. The importer keeps a number only when it applies to that kind of row **and** the captured source passage shows it:
  - all 495 electorate vote figures are evidenced by the passage and stored as reported, **including 9 genuine zeros**;
  - the 468 list rows' `candidate_votes = 0` and the 495 electorate rows' `list_rank = 0` are collector defaults with nothing in the source behind them; they are dropped and the drop is recorded, never stored as zero;
  - the earlier rule that turned any zero into "not reported" was wrong for this product and has been removed. A figure the passage did not evidence would be omitted (not reported), in either direction; there were none.
- **Ambiguity reported, not resolved.** All nine zeros are the nine candidates of one electorate, Port Waikato. The source page shows 0 for each, so 0 is what is stored. Whether that contest was held on the day is not inferred here.
- **Result.** 963 candidacies (495 electorate, 468 list) across 72 electorate contests and one list contest; 963 official-nomination status events with the Electoral Commission source class; 495 reported results; 468 list entries over 17 lists (ranks 1–76); 17 party labels; 963 source identities, **none merged**: 346 same-name proposals were filed for human review and none approved. Electorate types stay `unverified`. 0 rejected, 0 skipped, 0 ingest errors; the replay inserted 0 versions. Receipts: [receipts/](receipts/README.md).
- **Not covered.** Elected/not-elected outcomes, party votes, nationwide totals, turnout, boundaries. The 84 rows with no party label are stored with no party, not as "Independent".

## Adapters and loaders that are NOT implemented

Nothing below is imported, and no count is implied for any of it. "Blocked" means a decision or input outside this repository is needed; "not built" means engineering work remains.

| Dataset | Status | What is missing |
|---|---|---|
| 2026 official nominations and party lists | **Blocked + not built** | Official lists are not published until after nominations close (research note: noon, 8 October 2026), and the Electoral Commission sites refuse automated requests from this host. Needs a publisher-approved route, then a parser. The source already carries an explicit not-yet-published state. |
| Party announcements of candidates | **Not built, needs approval** | A separate, labelled feed with `source_class = party_announcement`. The status model is ready; collection needs an owner decision. |
| Register of political parties, registrations, aliases | **Blocked + not built** | Same publisher block. The 33 upstream historical identities are not a current register and are not imported. |
| 2023 official results (candidate, party, nationwide totals) | **Candidacies imported locally; rest not built** | Live route blocked. The verified 963-row candidacy product imports cleanly (see below). Party-vote and nationwide-total loaders (P08, P09) are not built, and nothing is on a hosted project. |
| Electorate boundaries 2025 review, official codes, General/Māori type | **Blocked + not built** | Electorate type stays `unverified`. No geometry: the published maps are images, not polygons. |
| Party and candidate finance returns (2023 returns, 2025 annual returns) | **Blocked + not built** | Table holds return status and official URL only. No loader. |
| Party policy pages | **Not built** | Table and classification-basis field exist. The upstream classification is unreviewed model output with unknown model metadata and would be imported as such, if at all. |
| Polls | **Not built, rights question** | Upstream source is a secondary aggregation. Needs pollster primary sources and a rights decision. |
| Written questions | **Not built** | Publisher moved to a separate questions site that renders client-side; needs an approved data route. 187,956 upstream records would go through an export contract. |
| Bills history, select committee business and reports | **Not built** | Only the current bills index is live. |
| MP roles, portfolios, party offices | **Not built** | Needs per-profile fetches; the research note found 119 of 122 profile fetches succeeded, so completeness would have to be measured per run. Service start and end dates need an official event source (for example Gazette notices); none is ingested. |
| Beehive releases history | **Not built** | Feed window only; history needs an export contract. |
| Statistics (census, series, social and economic samples) | **Not built** | Tables, vintages, suppression status and the one-route guard exist. No loader, and no route decisions are recorded in `stat_route_reconciliation`, so the database would refuse the rows. |
| Summaries and claims | **Deliberately not built** | Schema and review gates only. No model has been run. |

## Research handoff received during this work

A separate research note (20 September 2026) reports: 2026 boundaries of 71 electorates (64 general, 7 Māori) rather than the 72 used in 2023; nominations and party lists closing at noon on 8 October 2026; 17 registered parties; and 122 members listed with one vacancy attributed to a specific electorate. **None of this could be verified from the build host** (Electoral Commission sites were unavailable), so none of it is seeded. The schema is compatible with it: boundary editions are versioned, no electorate count is hardcoded, current members are never attached to 2026 boundaries, and the nominations source already carries an explicit not-yet-published state.

## Rights

All 19 publisher rights rows are mirrored from `catalogue/rights-register.json` and remain **pending / link-only**. Ingesting into the private store changes none of them. The release function refuses any item whose rights row is not approved, even with every gate open (tested).
