# Parliament live-fetch adapters: what was observed

Checked on **2026-09-20** from one development host, through the project's own fetch guard (honest automated
user agent, no Origin/Referer/cookie/token, no browser imitation, at least 3.5 s between requests to one host).
53 network requests in total, robots.txt reads and one redirect hop included. No response body, question text, reply text or bill text
was kept; only the counts and shapes below.

These are observations of undocumented public endpoints on one day. They can change without notice; each adapter
checks every row against what it asked for and fails closed when the answer stops matching.

Conventions used by all five adapters:

- Payloads are built only by `../payload.ts`, so this route and the reviewed-export route give the same content hash
  for the same publisher content.
- **A value the source does not give is OMITTED** (never `null`, never `""`, never `0`).
- A contact-like substring inside publisher free text (a title) is replaced with `[redacted]` before hashing, and the
  masking is listed in `omitted_fields`.
- The runner stores at most `max_records` per run and saves the cursor of the last page it saw. Every adapter here
  therefore requests a further page only when the whole page still fits; a stop for budget or time leaves
  `done=false`, the run is recorded as partial, and the next run resumes from the cursor.

## 1. Written questions — `nz_parliament_written_questions` (`written_questions.ts`)

Endpoint: `POST https://questions.parliament.nz/api/data/search` (JSON). Outcome: HTTP 200 on every well-formed
request. robots.txt: readable, 23 bytes, no rule against the path.

| Request | Reported `@odata.count` |
|---|---:|
| `{page, pageSize}` only (all Parliaments) | 683,311 |
| `parliament: "54"` | 187,956 |
| `parliament: "54"`, `dateFrom: "2024-05-01"`, `dateTo: "2024-05-31"` | 19,163 |
| `parliament: "54"`, `dateFrom` = `dateTo` = `"2024-05-31"` | 346 |
| `parliament: "54"`, 2023-11-01 to 2023-12-31 | 4,995 |
| `parliament: "54"`, 2023-11-01 to 2023-11-30 | 0 |

- **Parliament and date filters work.** `dateFrom`/`dateTo` filter on the release date and are inclusive at both ends.
- **Sort:** with no sort keys the order is newest release date first and is not stable inside one date. With
  `column: 0, direction: 0` the order is ascending by release date and then question number; `direction: 1` reverses
  it. The adapter uses ascending order so that newly released questions land after the position already read.
- **Page size:** 2, 5, 50, 100 and 250 all returned exactly the requested number of distinct rows. Nothing larger was
  tried. The adapter defaults to 100 (about 114 kB per page) and accepts `adapter_options.page_size` up to 250.
- An empty partition answers `@odata.count: 0`, `pageSize: 0`, `value: []`.
- **A page past the end answers HTTP 500**, so the end of a partition is computed from the total, never probed.
- Route: calendar-month partitions of the release date. Backfill walks every month from `backfill_from`
  (default 2023-11-01) to the month current in New Zealand; incremental walks the newest `incremental_months`
  (default 2), because replies change existing questions later (`lastModified` moves; a month released in May 2024
  showed rows last modified in December 2024).
- Drift rule: a month whose total **grows** while it is read is carried on (ascending order puts additions after the
  cursor; the incremental route re-reads recent months anyway). A month whose total **shrinks**, or that repeats an
  id, is read again from its first page, at most twice per run, and then the run fails with
  `source_changed_during_pagination`. Restarting on growth was rejected because the current month grows on most
  sitting days and a small-budget schedule would then never get past it.
- If every month asked about is empty (a recess, a dissolution), one unfiltered count for the Parliament is requested:
  above zero means a quiet window (the run succeeds with no records), otherwise the run fails.
- Dry run of the real adapter through the runner (incremental, page size 50, budget 100): 2 pages, 100 records,
  100 distinct ids, status `dry_run`.
- Size of a full backfill at page size 100: about 1,900 requests (well over an hour at the pacing above). It is meant
  for the CLI, resumed across runs, not for one scheduled function call.

## 2. Committee reports — `nz_parliament_committee_reports` (`committee_reports.ts`)

Endpoint: `POST https://selectcommittees.parliament.nz/api/data/search`. HTTP 200. robots.txt readable, 23 bytes.

- Body: `{keyword:"", documentPreset:0, page, pageSize, column:0, direction:1, searchTab:"All", parliament:"54"}`.
  **`totalResults`: 1,286.** Every row seen had `documentType: "SelectCommitteeReport"` and `parliamentNumber: 54`;
  the adapter requires both.
- `parliament` must be a string. An unrecognised key is silently ignored by this endpoint (upstream finding), which
  is why rows are checked rather than trusted.
- `column: 0` is not a date sort on this host: neither direction returned publication dates in order. The proven
  request (direction 1) is kept; a total that changes between pages fails the run, as in the current-bills adapter.
- Page sizes observed: 2, 3, 50. The adapter accepts up to 100; 100 was not tried live.
- Dry run (budget 50): 1 page, 50 records, 50 distinct ids. A full walk is 26 requests at page size 50.

## 3. Business before committees — `nz_parliament_committee_business` (`committee_business.ts`)

Same endpoint. Body: as above but `documentPreset: 1` and `beforeCommittee: true`.

- **`totalResults`: 123** with the flag; **1,657** without it (all Parliament 54 business items).
- Rows carry `documentType` (seen: "Bill", "Whole Of Government Direction") and often `itemType: null`. Both labels
  are kept when present (`document_type`, `item_type`).
- Dry run of the real adapter: 3 pages, **123 records, 123 distinct ids, complete snapshot**.
- **Not verified:** the public page path per item type. The search result carries no page address, the site is a
  client-rendered shell that answers 200 for any path, and the upstream collector recorded none. The family default
  `/v/13/<id>` is used. A person should open one bill item and one non-bill item before these links are published.

## 4. Bill publications — `nz_parliament_bill_publications` (`bill_publications.ts`)

Three anonymous requests per bill at most, two hosts.

- `POST https://bills.parliament.nz/api/data/search` (the current-bills request): **`totalResults`: 93**.
- `GET https://bills.parliament.nz/api/data/Bill/<id>`: HTTP 200 without Origin or Referer. Gives `BillNumber`,
  `Title`, `BillStatusName`, `BillCurrentStageName`, `ParliamentNumber`, `InitiationDate` and `BillLegislationUrl`
  (seen form: `https://www.legislation.govt.nz/bill/government/<year>/<n>/en/latest/`). The summary text in the
  detail is never placed in a record.
- `www.legislation.govt.nz`: **no challenge and no block** was met from this host with the project's user agent.
  robots.txt is readable (115 bytes) and **disallows the versions path**; under the owner's recorded policy that is
  logged as an advisory (`robots_advisory_disallowed`) and the read-only request proceeds. A person should weigh it.
- Versions index: `/<bill path>/<version date>/versions/?per_page=100&sort=asc&page=N`. HTTP 200, about 46 kB, lists
  one card per revision with a link `/<bill path>/<token>.pdf`. It contains no bill text.
  - `.../en/latest/versions/...` answers **404**. A date that is not a real version date answers **404**.
  - The old address `.../latest/versions.aspx` redirects to the bill's main page (about 1.3 MB, the bill text
    itself). The adapter never requests it.
  - The detail's `InitiationDate` (the publisher's local date, as written) was a valid version date for **3 of 3**
    bills tried (one introduced in 2026, two in 2025). That is a small sample. When it is not valid the index answers
    404 and the set record says `publication_index_status: "unavailable"` with **no count**; nothing is guessed.
- Dry run (budget 4): bill list 2 pages, first bill in id order gave 1 set + 2 revisions
  (`bill_government_2025_126_en_2025-02-27.pdf` first); the second bill was read but not emitted because its records
  did not fit the budget (a bill is never split across runs).
- No PDF is requested, ever. Tests assert that no requested address ends in `.pdf`.
- Never a complete snapshot: a bill leaving the current list, or an index unavailable this time, must not tombstone
  revisions the publisher still serves.
- A full run is about 190 requests across the two hosts (about 5 to 6 minutes at the pacing above).

## 5. Government releases listing — `nz_government_releases_listing` (`releases_listing.ts`)

- `GET https://www.beehive.govt.nz/releases?page=1`: **HTTP 200 with a 212-byte firewall challenge page**; the guard
  classed it `challenge` and raised `SourceUnavailableError` (`publisher_challenge`). One attempt was made. Nothing
  else was tried. robots.txt on the same host was readable (HTTP 200, 2,027 bytes).
- **BLOCKER:** from this host the listing is not available to an honest automated client, so the live markup was
  never seen. The parser is written for a generic listing row (a link to `/release/<slug>`, an optional
  `<time datetime>`, an optional node id) and is tested only on a hand-written structural sample labelled as a parser
  fixture. It must be checked against one real page by a person with ordinary browser access before this source is
  enabled. Until then the source should stay `enabled: false` with this reason.
- Assumptions that are therefore unverified: page numbering starts at 0; rows link to `/release/<slug>`; a
  machine-readable `datetime` is present. Without a machine-readable instant the adapter stores no publisher date.
- The builder has no `published_at_text` key; only an ISO instant is kept (`published_at`).

## Blockers and open items, in one place

1. Beehive listing challenged (section 5): adapter and parser exist and fail closed; markup unverified.
2. legislation.govt.nz robots.txt disallows the versions path (section 4): advisory recorded, owner decision.
3. Version-date derivation from `InitiationDate` verified on 3 bills only (section 4).
4. Public page path per committee business item type not verified (section 3).
5. The month-partition loader mentioned in upstream reports was not available to read; the request contract above
   was established from the public endpoint itself, with page size 2 to 5 for every exploratory request.

## Proposed registration (`index.ts`)

`index.ts` exports the adapters by name, the source configurations and the proposed schedules; the family's registry
fragment merges them. Enabled there: written questions (newest two months), committee reports, committee business —
the three routes exercised end to end on 2026-09-20. Not enabled, each with its reason: the written-questions
backfill (CLI only), bill publications (owner decision on the robots.txt advisory; small verification sample) and
the releases listing (challenged). The scheduled function accepts at most 2,000 records per call, so a pass over two
months of written questions is a chain of partial runs resumed from the checkpoint.
