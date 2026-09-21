# Public factual values: what an anonymous reader actually receives

This is project process documentation, not legal advice. It records one change: the imported public-safe factual
values, links, relationships and provenance are now shown to anonymous readers instead of being displayed as blank
cells. It records how that was measured, what is deliberately still withheld, and what nobody has done.

> **State of this work:** implemented and measured on **an isolated disposable local database holding the real
> imported data for all 24 catalogue products** (all 20 prior migrations, 203,311 ledger records, 1,273,423
> statistical observations). **Nothing has been pushed, merged, deployed, or written to a hosted project.** No
> schedule was activated against any hosted project. The hosted steps in section 7 are for the coordinator.
>
> **Nothing here is a review or a permission.** Every one of the 22 rights rows is still `pending` / `link-only`,
> every `REVIEW-REGISTER.md` row is still PENDING with nobody appointed, both release gates still read `closed`,
> and `surface_status.release_basis` still reports `owner_override`. That an official body prints a figure on a
> public page is not that body's permission to republish it, and this document does not say it is.

## 1. The defect, measured rather than described

`scripts/db/public_value_audit.sql` reads every dataset of `evidence_public` and `evidence_open` **with
`set role anon`**, column by column, and reports three things: what an anonymous reader can read, whether those
columns carry a value, and the gaps as gaps. Run against the loaded store before any change:

| | Before | After round one | After round two |
|---|---|---|---|
| Datasets an anonymous reader can read | 122 | 122 | 123 |
| …that return at least one row | 94 | 94 | 95 |
| Rights-gated content columns | 359 | 359 | 363 |
| **…that carry a value** | **206** | **297** | **304** |
| **Content columns published and empty** | **130** | **39** | **36** (19 exact, 17 sampling-window) |
| **Payload keys held by a source and not shown** | not measured | **108** | **18**, every one a stated withholding |

The audit measures any dataset larger than 20,000 rows over an arbitrary window of that size; nine are
(`stat_observations`, `source_observations`, `source_records`, `source_record_versions`, `records`,
`record_versions`, `documents`, `written_questions`, `record_route_keys`). Only one produced a misleading row:
`stat_observations` holds 1,273,423 rows over **eight** sources, and the window lands inside the 882,180-row 2013
meshblock source, which holds none of `raw_value`, `period_start`, `period_end`, `source_status`, `source_symbol`
or `value_double`. Measured exactly per source, all six carry values (for example `source_status` on 229,961 of
234,325 release-series observations) and all six are named by a current owner scope for the sources that have them.

So after round two the 36 remaining "empty" columns are **17 sampling-window artifacts, 5 deliberate withholdings
(section 4), and 14 columns the store genuinely holds nothing for** — each of the 14 counted exactly as 0 of N, not
sampled. The audit labels every Part C row `exact` or `sampled window` so this cannot be misread again. Of the 18
payload keys still not shown, over seven sources, **every one is a stated withholding**: nine measurements of text
this project does not hold, four committee titles and subtitles (R7), and five upstream classification labels (R9).

Of the 130 empty columns before the change, 103 held values privately: they were blank in public not because of a
decision about them but because the forbidden-name rule on an owner `source_fields` scope refuses any token holding
"vote", "value", "total", "amount", "seats", "rank", "share" or "pct" — and, separately, any token holding "text",
"content", "image" or a publisher identifier, which caught several columns that are none of those things.

What was loaded and blank, with the counts the store holds:

| Blank in public, present in the store | Rows |
|---|---|
| `candidate_results.votes`, `.value_status` | 495 |
| `party_results.votes`, `.value_status` | 1,224 |
| `election_party_totals` — party votes, share, electorate and list seats, denominator note | 17 |
| `election_result_totals` — party votes, seats, totals | 1 |
| `electorate_result_summaries` — votes counted, per cent counted, informal and line tallies | 72 |
| `party_list_entries.list_rank` (and `candidacies.list_rank`) | 468 |
| `result_route_checks.this_route_votes` | 496 |
| `finance_published_aggregates.amount_nzd`, `.value_status` | 1,504 |
| `source_records.external_record_id` / `records.external_record_id` | 203,311 |
| `source_record_versions.source_date_text` | 203,423 |
| `written_questions` — document, asker, portfolio and status references | 187,956 |
| `stat_observations` — qualifiers, row locator, parse and upstream status | 1,273,423 |
| …and 20 further columns of bills, committee reports, report files, statistics releases and summaries | — |

## 2. What changed

`supabase/migrations/20260921060100_public_factual_values.sql` (additive; no applied migration was edited):

1. **The forbidden-name rule stays**, with a closed list of vetted exceptions — seven at this point, thirteen
   after round two: `external_id`, `external_record_id`, `publisher_item_id`, `source_date_text`, `content_kind`,
   `text_extraction_status`, `publisher_modified_text`. Each was read on the loaded store before it was listed — the external ids are the
   publisher's own GUIDs, page slugs and digests; `content_kind` is `minister` or `portfolio`;
   `text_extraction_status` is `extracted`; `is_image_only` is a true/false flag about a PDF being a scan. The list
   is **names, not prefixes**: `external_id_hash` and `source_date_text_raw` are still refused, and a test says so.
2. **Two new scope kinds**, built exactly like the existing `statistical_facts`: a closed token list in a table
   constraint, and an eligibility rule checked **both** when a decision is recorded (`owner_scope_guard`) **and
   every time a release tier is read** (`evidence_private.source_release`), so a source that stops being that kind
   of product loses the figures at once.

   | Scope kind | Tokens | Only for a source registered as |
   |---|---|---|
   | `official_result_figures` | votes, votes_status, vote_share, party_votes, party_vote_share, electorate_seats, list_seats, total_seats, list_rank, votes_counted, votes_counted_pct, candidate/party votes-with-informals, informals, lines, this_route_votes, value_status | `election_2023_results` |
   | `official_finance_figures` | amount_nzd, value_status, total_status, is_image_only | `candidate_finance_returns`, `party_finance_returns` |

3. **`evidence_public.surface_status.owner_figure_scopes`** publishes which kinds of figure currently rest on the
   owner's decision. The explorer's notice on every page reads that column instead of asserting anything itself, so
   revoking one kind changes the wording by itself.

`governance/owner-authorizations.json` gains **`OWNER-AUTH-2026-09-21-01`** (the two earlier entries are byte-for-byte
unchanged; an entry is never edited). It records 37 scopes over 30 sources — 31 `source_fields`, 3
`official_result_figures`, 3 `official_finance_figures` — each with the basis for that source. Every field in it was
derived by reading the loaded store: a column was listed only if it holds a value for that source today.

**The owner gave a direction, not a field list.** The recorded request is *"Ok well we want all the data and links etc
to show"*, with a later clarification that officially disclosed donor names, amounts, dates, recipients and
original-return links belong in the explorer while residential addresses, signatures and contact details do not.
Both were relayed by the release coordinator; neither message is held in this repository. Every field list below was
**derived** from that direction by reading the loaded store column by column and key by key, and each entry records
that it was derived rather than dictated. The direction is what authorizes them; no further field-by-field approval
is treated as a precondition here.

### Round two: `20260921070100_public_payload_and_poll_figures.sql`

An adversarial re-read of the first migration against the loaded store found three things (section 5a). The second
migration, also additive:

1. **Six more vetted exceptions**, each read on the store first: `vote_type` (`party` / `candidate`),
   `candidate_votes_evidence` and `list_rank_evidence` (the single word `number_found_in_captured_source_passage`),
   `text_layer_status` (one of three status words), `transcription_scope` (this project's own sentence about what
   it entered from a return) and `published_at_text` (a date as printed, `1 August 2026`). Still names, not
   prefixes: `vote_type_count` is refused.
2. **A third figure scope, `published_poll_figures`** (`value_pct`, `value_status`, `sample_size`,
   `disclosure_sample_size`, `results`), for a source registered as `party_vote_polls` only — and the result and
   finance token lists gain the **payload keys and columns** that carry the same facts (`candidate_votes`,
   `candidate_total`, `party_total`, `vote_percent`; `aggregates`, `amounts_basis`, `donations_as_published_nzd`,
   `expenses_as_published_nzd`, `loans_as_published_nzd`), because a payload key and a column name share one
   namespace and a figure must be named where figures are named.
3. **The methodology label travels with the poll figure**: `methodology_status` becomes link metadata, `value_pct`
   and `value_status` are withheld from the raw table projection, and the new curated view
   `evidence_public.poll_figures` carries the figure, the pollster, the sponsor, the fieldwork dates, the official
   link and the label in one row.

`surface_status.owner_figure_scopes` is now derived from "every field scope that is not the descriptive one", so a
future figure scope needs no edit to the generator. `governance/owner-authorizations.json` gains
**`OWNER-AUTH-2026-09-21-02`** — 27 scopes over 21 sources, 160 field names, every one of them a key that Part D
showed was held and not shown — and the three earlier entries are byte-for-byte unchanged.

## 3. What an anonymous reader now receives (measured, `set role anon`)

```
candidacies · 963 rows · 495 with a vote count · 468 with a list position · 495 with a result status
  Auckland Central | MURALIDHAR, Mahesh | National Party | electorate |       | 12728 | reported | final
  Auckland Central | COKER, Christopher | Aotearoa Legalise Cannabis Party | electorate |  | 365 | reported | final

election_party_totals · 17 rows
  party_votes 1085851 | share 38.080000 | electorate_seats 43 | list_seats  5 | reported
              767540  |       26.910000 |                 17 |            17 | reported
  denominator_note: "Share exactly as the official table prints it (per cent of valid party votes)."

electorate_result_summaries · 72 rows
  votes_counted 35463 | counted 100.000% | candidate votes with informals 34746 | informals 299 | party lines 17

party_results · 1,224 rows · 1,224 with a number, each as its own electorate contest reported it

finance_published_aggregates · 1,504 rows, from the Commission's own public index pages
  candidate_donations 492 rows, 492 with an amount, max 207,662.00
  candidate_expenses  492 rows, 492 with an amount, max  32,560.84
  party_donations_sum  14 rows,  14 with an amount, max 6,275,234.46

records · 203,311 rows · 203,311 publisher identifiers · 199,663 publisher dates as printed

poll_figures · 144 rows, the only public path to a poll figure — the label is in the row, not a page away
  Anacta | ACT  |  8.000 | reported     | unresolved | 1701 | https://storage.googleapis.com/asapop-...
  Anacta | CPNZ |        | not_reported | unresolved | 1701 | https://storage.googleapis.com/asapop-...
  Anacta | GRN  | 14.000 | reported     | unresolved | 1701 | https://storage.googleapis.com/asapop-...
poll_results (the raw table projection) · value_pct and value_status do not exist as columns at all

safe_payload, key by key · 14 of 14 for the 2023 candidacy product (was 5 of 14), 22 of 22 for the candidate
  finance returns (was 2 of 22), 9 of 9 for the party aggregates, 22 of 22 for the electorate results, 21 of 21
  for the polls, 8 of 13 for the party policy pages (the 5 are unreviewed classification labels), 20 of 24 for
  written questions, 7 of 9 and 9 of 11 for committee business and reports. 18 keys across seven sources are
  withheld; section 4 names every one and why
```

A vote count is still a number the source reported, never an inference: `value_status` travels with every figure and
a cell the publisher printed no number for reads as its status, never as zero. Nothing is ordered by a figure: the
curated lists offer no figure as a sort key and the generic dataset browser refuses any column whose type is numeric
or whose name is a tally, share, seat count, rank, total or amount (`web/src/lib/generic-sort.ts`, R1).

## 4. Deliberately still withheld — and the rights uncertainty behind each

These are decisions, not oversights. Each is visible in `evidence_public.dataset_columns` with its reason.

> **Reversed on the second pass: poll figures are now published.** The first pass withheld them because RIGHTS-07 is
> pending — which is true of every source here, and is exactly what the owner's direction overrides. Withholding one
> product for the reason that applies to all of them was not a judgement, it was an inconsistency. They are now
> released by `published_poll_figures`, on the same terms as every other figure scope, with one extra rule the others
> do not need: `methodology_status` is link metadata, so the label that says whether that pollster disclosed a
> methodology is shown at every tier for every source and **cannot be blank beside a figure**, and the figure columns
> are withheld from the raw table projection so the only public path carries the label in the same row. 3 of the 12
> polls held read `unresolved`, and a reader sees that word next to the number. What would still stop a poll figure is
> the one thing that should: a publisher's recorded restriction, which gives `tier = none` and hides the source
> entirely (asserted).

| Withheld | Reason | Rights uncertainty, stated |
|---|---|---|
| `finance_return_references.approved_total` | It would be a number read from **inside** a return document. Not on any token list, anywhere. | None. Nothing is read from inside a return; the stored records say `amounts_basis = commission_index_page_as_published` and `total_status = not_extracted`, and `total_status` **is** published so the reader is told this plainly. |
| `upstream_unreviewed_label` and four `upstream_label_*` payload keys of the party policy pages | An upstream classification with no recorded model run and nobody's review (R9). | None. The typed `policy_class` (`unknown`) and `classification_basis` (`none`) are both published, so a reader is told that nothing has been classified. |
| `committee_reports.subtitle`, and the `title`/`label` of any committee report or item of business | 247 of the 1,286 reports are petition reports whose titles name the private person who petitioned (R7); a field decision cannot tell a petition from a briefing. | None, but note the measurement: `subtitle` holds only "Final Report" (1,264) and "Interim Report" (22) today. It is withheld anyway, because the protection is on the file rule, not on today's data. A test refuses any entry that names these fields for a committee source. |
| `identity_decisions.evidence` | Free-form working evidence about a named person; nothing a field decision can check bounds its future contents. | None. The decision, its method and its status are published. |
| Seven payload keys measuring text this project does not hold: `question_text_chars`, `question_text_sha256`, `reply_text_chars`, `reply_text_sha256`, `release_text_chars`, `extracted_text_chars`, `extracted_text_sha256` | A character count and a digest are not text, but `OWNER-AUTH-2026-09-20-02` recorded, as the basis for showing written questions at all, that *"only a digest of it is held, and that is not shown"*. Contradicting a recorded decision to publish a measurement of material we deliberately do not keep is not worth it. | None. They are measurements of absent material, not facts about the world. |
| Canonical people and parties, bodies, summaries, copied passages, contact details, images, model output | Unchanged from before; `public_withheld` and the R9 row rules were not touched. | None. |

**Gaps that are gaps, not withholdings.** 14 published content columns are empty because the store holds nothing
for them, not because anything is hidden. Each was counted exactly, not sampled:

| Column | Rows | With a value |
|---|---|---|
| `bills.party_label_at_source`, `.select_committee` (and in `documents`) | 3,634 | 0 |
| `releases.publisher_item_id` | 4,735 | 0 |
| `candidacy_status_events.status_date` | 963 | 0 |
| `candidate_results.vote_share` | 495 | 0 |
| `committee_business_items.item_type` | 123 | 0 |
| `parliamentary_service_terms.parliament_number`, `.valid_to` (and in `service_terms`) | 122 | 0 |
| `role_terms.valid_from`, `.valid_to` | 111 | 0 |
| `result_sets.declared_on` | 3 | 0 |

The publisher did not state them, or the loader does not read them. They are named here so that "blank" is never
left ambiguous, and every one of them is also named in `evidence_public.dataset_columns` with its release class.
`written_questions.answered_on`, `.lodged_on` and `.portfolio` are empty in the same way (0 of 187,956); the
publisher's own references for the portfolio, the asker, the document and the answer status **are** published, so a
reader can follow the question to the publisher's page that does state them.

## 5. Donors: absent from the store, not hidden by a decision

The owner asked for officially disclosed donor names, amounts, donation dates, recipients and original-return links,
and asked that donors not be blanket-hidden as private. **This project has never collected a donation record**, so
there is nothing of that kind to publish, and saying "withheld for privacy" would have been untrue. The evidence:

| Finance product | What the captured artifact actually holds | Donor-level facts |
|---|---|---|
| P15 · 2023 candidate returns (492 records) | candidate and party name as published, electorate as published, reporting year, return kind, page count, scan flag, the return's official URL and digest, and the Commission's own index-page totals for **donations, expenses and loans** per candidate with a status each | none |
| P16 · 2025 party finance aggregates (14 records) | party name as published, period start and end, and a list of the Commission's published totals (`party_donations_sum`, `party_loans_sum`) each with `amount_nzd`, `value_status`, `filing_dates` and `audit_report_as_published`, plus `return_urls` to the original returns | none |
| P17 · 2025 party returns (23 records) | document metadata only: version type, page counts, pages visually reviewed, transcription scope, scan flag, official URL | none |

There is no donations table, no donor column anywhere in the schema, and the loader's own contract
(`ingest/src/families/election/contracts.ts`, `FORBIDDEN_KEY`) refuses any key matching `donor.*` or
`contributor.*` at any depth, so no per-donation row has ever entered the ledger. Per-donation disclosures are a
separate Electoral Commission publication this project has not ingested; getting them would be an **ingestion**
change (a new product, a new contract and a relaxation of that key rule), not a publication change, and it is out
of this lane.

What this lane did do is publish every disclosed finance fact that **was** captured and had been sitting unread in
the payload: the amounts as published, the filing dates, the audit-report status, the party and candidate names as
published, the electorate, the reporting year, and the link to each original return document. Duplicate counting
across annual and election-year disclosures is not possible from what is published: each aggregate row is unique per
`(source_record_id, metric)`, carries its own `reporting_year` and `basis`, and nothing anywhere sums across returns
— there is no aggregate view, and the explorer offers no total.

## 5a. The adversarial re-read, and what it found

Everything in this section was checked against the loaded store, not reasoned about in the abstract.

| Checked | Result |
|---|---|
| **Does the audit actually cover what a reader receives?** | **No — a real gap.** `safe_payload` is one column whose keys are gated individually. The column-level audit called it "carries a value" while the reader was getting 5 keys of 14, 2 of 22, or 0 of 13. 108 keys were held and not shown. Part D of the audit now measures keys, as anon, and the second owner entry closes the gap. |
| **Could a poll figure appear without its methodology label?** | **Yes — fixed.** `evidence_open.poll_results` has no methodology column. `methodology_status` is now link metadata (shown at every tier for every source, needing no decision at all) and the figure columns are withheld from that table projection entirely; the only public path is `evidence_public.poll_figures`, where the label is in the same row. |
| **Revoked scope** | A revoked entry removes every figure and field it named at the next read, leaves the rows, and empties `owner_figure_scopes`. Asserted in both new test files, including with **both review gates open**, so nothing is being held up by the gates instead. |
| **Restricted-source inheritance** | A restricted rights row gives `tier = none`, which hides the source and everything descended from it, and empties `owner_fields` **where the tier is read** rather than only where the decision was recorded. Asserted for a poll source that is restricted after its decision was recorded. |
| **A value evidenced by one source, displayed on another source's row** | Structurally possible for a shared civic row (an electorate version can be attested by several sources). Measured: all 72 electorate versions are attested by the 2023 candidacy product, and **0 of 495** candidacies display an electorate name their own source did not state. A standing pgTAP assertion now fails if any published candidacy ever shows an electorate name whose evidencing source is invisible. `result_route_checks.other_route_votes` — the one place a second source's figure is deliberately stored — was already withheld for this exact reason and stays withheld. |
| **Source identity spoofing** | Every path fails closed. A scope is keyed to `(source_id, rights_id)` and the registry product is re-checked on read: re-pointing a source at another product **removes** its figures (asserted); changing its `rights_id` **breaks** the scope match and removes its fields; a new source gains nothing because no scope names it. The worker cannot write the owner tables or run the sync. **Stated limit, unchanged by this lane:** `sync_registry` is worker-callable and can rewrite a source's `title`, `publisher`, `official_url` and `registry_key`, so the publisher attribution shown beside a figure is only as trustworthy as the registry sync. That is a property of the existing design, not of this change, and belongs in the security review. |
| **Unreviewed classifications** | The party policy pages carry five upstream label keys (`upstream_unreviewed_label` and four `upstream_label_*`). None is released: no model run is recorded and no person has reviewed them (R9). The typed `policy_class` stays `unknown` with `classification_basis = none`, and both are published, so a reader sees that nothing was classified rather than a silent blank. |
| **Anonymous writes and private reads** | Re-asserted in both new test files after every change: private schema denied, release tiers unreachable, update/delete/insert denied on the projections, and no write privilege on the projections or the tables behind them. |

**One defect the suite caught in this change, worth recording.** The first draft of the new curated view was left
owned by the role that owns the private tables — the one role exempt from row level security — because a view runs
its body with its owner's privileges. `090_review_pr8.test.sql` has asserted since before this lane that no view in
any of the four schemas is owned by that role, and it failed. Fixed by giving `evidence_views.poll_figures` to
`evidence_inspector_reader` like every other base view, with the one grant and read policy that role was missing
(`poll_results` had never appeared in a base view before). A reviewer adding a curated view should expect this.

## 6. Tests

| What | Where | Result |
|---|---|---|
| pgTAP, whole suite, against a database rebuilt from the migrations (what CI runs) | `supabase/tests/*.sql` (19 files) | **643 assertions, all pass** |
| pgTAP, whole suite, **against the store holding the real data of all 24 products** | same | **643 assertions, all pass** |
| Round one: figure scopes, from both ends | `supabase/tests/125_public_factual_values.test.sql` | 51 assertions |
| Round two: poll figures, the label that travels, the payload key by key, and the two adversarial paths | `supabase/tests/126_poll_figures_and_payload.test.sql` | 36 assertions |
| Ingestion, release tooling and the owner-file validator | `ingest/`, `tools/` | **271 pass, 0 fail, 0 skipped**, with the six integration tests run against the disposable stack (`EVIDENCE_TEST_LOCAL_STACK=1 EVIDENCE_REQUIRE_INTEGRATION=1`, where a skip is a failure) |
| Explorer unit tests, typecheck, generated types | `web/` | 45 pass; typecheck clean; `types:check` reports the committed types match the migrations |
| Red lines (documents, data, explorer copy) and catalogue validators | `scripts/`, `tools/red_lines_copy.ts`, `tests/` | clean; 20 Python tests pass |

**Not run here, and why.** The Playwright browser tests (`npm run e2e`, `npm run e2e:pages`) were not run: they seed
fixtures into the database and open both release gates, which would have destroyed the measured state this document
rests on, and this host was already running three other local stacks. The explorer change is covered by unit tests
(the notice reads `owner_figure_scopes` from the database and names no figure the database does not report). The
coordinator should run both e2e suites against a disposable stack before any deployment; `access.spec.ts` already
asserts the override path end to end and its assertions on the notice text still hold.

`125_public_factual_values.test.sql` asserts, on fixtures it creates and rolls back:

- a `source_fields` decision still refuses a vote count, a published share, a money amount, a poll figure, a sample
  size, contact data, a body, an image and the postal address of a donor — **from the table constraint**, not by
  convention; and the seven exceptions are accepted while their near-neighbours are not;
- a result-figure scope is refused for a finance source, a poll source and a statistics source, and a finance-figure
  scope for a results source and a poll source; `approved_total` is refused everywhere;
- a figure decision **cannot be recorded against a restricted rights row**, and such a source is `tier = none`;
- with the decision in force an anonymous reader gets `votes = 4321`, `votes_status = reported`,
  `result_status = final` and `list_rank = 3` — the numbers the fixture source reported — while both review gates
  still read `closed` and `release_basis` reads `owner_override`;
- **revoking the decision takes the numbers away and leaves the rows**: both rows still visible, not one figure
  survives, and `owner_figure_scopes` empties — even with both review gates open;
- anonymous private reads and every anonymous write stay denied.

`126_poll_figures_and_payload.test.sql` asserts, on its own fixtures:

- with **no decision at all**, a poll row already shows `methodology_status` and shows no figure and no pollster;
  `evidence_open.poll_results` has no `value_pct` and no `value_status` column to read;
- `published_poll_figures` is refused for an election-results source, and the other figure scopes for a poll source;
  `methodology_status` is refused as a poll token, because it is link metadata and needs no decision;
- with the decision in force, the figure (`31.5`), the not-reported status of a second party, the sample size, the
  official link and the `unresolved` methodology label are **all in one row**, and `surface_status` names the scope;
- the payload carries **exactly** the keys the decision names and no others — asserted against a literal object, so
  a key sliding in silently fails the test;
- a publisher's restriction removes the whole poll, figure and label together, and empties `owner_fields` where the
  tier is read;
- re-pointing a source at another registry product **removes** its figures rather than gaining any;
- no published candidacy shows an electorate name whose evidencing source is invisible (measured over whatever the
  database holds, real rows included);
- revoking leaves the label and takes the figure, and an anonymous write is still refused.

## 7. Exact steps for the coordinator (hosted; none of this was run here)

Nothing below was run against any hosted project by this lane. Run them in this order, as administrator, with the
connection from `PG*` variables and a password file (runbook step 0), and **not while a loader is running**:
`rebuild_exposed_views()` takes exclusive locks and will deadlock against a live import.

1. **Read the two owner entries once** (`governance/owner-authorizations.json`, ids `OWNER-AUTH-2026-09-21-01` and
   `-02`). They are derived field lists, recorded as derived; the owner's direction is what authorizes them, so this
   is a read, not an approval step. Mirroring makes an entry immutable, so anything actually wrong is easier to
   change now than later.
2. **Pre-flight, read-only:** `psql -f scripts/db/inspect_existing_objects.sql`; keep the output.
3. **Migrations:** confirm `20260921060100_public_factual_values.sql` and `20260921070100_public_payload_and_poll_figures.sql` are the only unapplied files
   (`supabase db push --dry-run`), then `supabase db push`. It is additive: it alters constraints on
   `owner_authorization_scopes`, replaces three functions and one view, and re-runs `classify_public_columns()` and
   `rebuild_exposed_views()`. On a store with every migration applied the final readout was `{"open_tables": 89,
   "public_views": 31, "inspector_views": 35, "not_exposed_default_deny": 0}` and `classify_public_columns() = 1143`
   (the extra view is `evidence_public.poll_figures`); compare with the same call before the push rather than with
   these numbers, because they count objects and a hosted store missing an earlier migration will differ.
   `not_exposed_default_deny` must be 0 either way.
4. **Owner file:** `node tools/owner_authorization.ts` (expect `valid; 112 scope(s) in force today` while all four
   entries are current), then `psql -v ON_ERROR_STOP=1 -f scripts/db/sync_owner_authorizations.sql`. Expect
   `{"recorded": 2, "revoked": 0, "unchanged": 2}` on a hosted store that has never seen these two entries.
5. **Readback, the same script prints it:** gates `closed`, `public_rows_released = t`,
   `release_basis = owner_override`, `rights_rows_not_pending = 0`.
6. **Anonymous audit:** `psql -v ON_ERROR_STOP=1 -f scripts/db/public_value_audit.sql`. Expect Part B to list every
   one of the 24 products with a non-zero `owner_fields`; Part C to hold only rows marked `exact` that are named in
   section 4 as withholdings or in section 4 as store-empty, plus `sampled window` rows, which are not gaps; and
   **Part D to hold only the 18 keys section 4 names**. Anything else in Part C or Part D is something this change
   did not reach.
7. **From outside the database**, with the anon key only:
   `GET /rest/v1/candidacies?select=candidate_name,votes,votes_status,list_rank&votes=not.is.null&limit=5` returns
   real numbers; `GET /rest/v1/poll_figures?select=pollster,party_label_at_source,value_pct,methodology_status&limit=5`
   returns a figure with its label in the same row; `GET /rest/v1/poll_results?select=value_pct` returns HTTP 400
   (that column does not exist publicly); `GET /rest/v1/finance_published_aggregates?select=metric,amount_nzd&limit=5`
   returns the Commission's published totals; `GET /rest/v1/surface_status` shows four entries in
   `owner_figure_scopes`; anonymous `POST`/`PATCH`/`DELETE` on both public schemas are refused; `evidence_private`
   and `evidence_views` are unreachable.
8. **Explorer:** `npm run types:check` must pass against the hosted schema's local equivalent before a rebuild;
   redeploy the Pages shell only under the existing `pages_deploy` scope and `PAGES_DEPLOY_ENABLED`.
9. **To withdraw:** mark `OWNER-AUTH-2026-09-21-01` and/or `-02` `revoked` in the file and re-run step 4. Each
   entry can be withdrawn on its own — revoking `-02` alone takes back the payload keys and the poll figures and
   leaves the round-one figures standing — and everything either names disappears immediately, with no deployment.
   Closing a release gate is not needed and would not be the right lever: the gates record reviews.

## 8. What nobody has done

No legal review (R10). Nobody has accepted the accountable-person role (R8). No publisher has approved or licensed
anything; all 22 rights rows are `pending` / `link-only`. No security sign-off. No hosted write, deployment, merge
or push was made by this lane. The field lists were derived by reading the store, not dictated field by field, and
both entries say so.

**Three things a reviewer should look at that this lane did not settle.**

1. **Poll figures are the most commercially sensitive republication in the set.** A pollster's numbers are that
   pollster's own product, RIGHTS-07 is pending, and the owner's direction is what carries them. They are labelled,
   linked and revocable in one step, and a recorded restriction removes them, but nobody with standing has looked
   at them. This is the one item here that most deserves the R10 review.
2. **`sync_registry` is worker-callable** and can rewrite a source's `title`, `publisher`, `official_url` and
   `registry_key`, so the publisher attribution shown beside a figure is only as trustworthy as the registry sync.
   Every path through it fails closed for *releasing* a figure (asserted), but the attribution itself is not
   protected. Pre-existing; belongs in the security review.
3. **Per-donation disclosures are not in the store and cannot be added by a publication change.** The owner asked
   for them; getting them needs a new ingested product, a new export contract, and a relaxation of the loader's
   `donor.*` key rule — an ingestion decision with its own rights and privacy questions (section 5).
