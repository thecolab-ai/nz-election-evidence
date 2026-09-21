# Public factual values: what an anonymous reader actually receives

This is project process documentation, not legal advice. It records one change: the imported public-safe factual
values, links, relationships and provenance are now shown to anonymous readers instead of being displayed as blank
cells. It records how that was measured, what is deliberately still withheld, and what nobody has done.

> **State of this work:** implemented and measured on **an isolated disposable local database holding the real
> imported data for all 24 catalogue products** (all 20 prior migrations, 203,311 ledger records, 1,273,423
> statistical observations). **Nothing has been pushed, merged, deployed, or written to a hosted project.** No
> schedule was activated and no loader was run. The hosted steps in section 6 are for the coordinator.
>
> **Nothing here is a review or a permission.** Every one of the 22 rights rows is still `pending` / `link-only`,
> every `REVIEW-REGISTER.md` row is still PENDING with nobody appointed, both release gates still read `closed`,
> and `surface_status.release_basis` still reports `owner_override`. That an official body prints a figure on a
> public page is not that body's permission to republish it, and this document does not say it is.

## 1. The defect, measured rather than described

`scripts/db/public_value_audit.sql` reads every dataset of `evidence_public` and `evidence_open` **with
`set role anon`**, column by column, and reports three things: what an anonymous reader can read, whether those
columns carry a value, and the gaps as gaps. Run against the loaded store before any change:

| | Before | After |
|---|---|---|
| Datasets an anonymous reader can read | 122 | 122 |
| …that return at least one row | 94 | 94 |
| Rights-gated content columns | 359 | 359 |
| **…that carry a value** | **206** | **297** |
| **Content columns published and empty** | **130** | **39** |
| …on a dataset that holds no row at all | 23 | 23 |

The audit measures any dataset larger than 20,000 rows over an arbitrary window of that size; nine are
(`stat_observations`, `source_observations`, `source_records`, `source_record_versions`, `records`,
`record_versions`, `documents`, `written_questions`, `record_route_keys`). Only one produced a misleading row:
`stat_observations` holds 1,273,423 rows over **eight** sources, and the window lands inside the 882,180-row 2013
meshblock source, which holds none of `raw_value`, `period_start`, `period_end`, `source_status`, `source_symbol`
or `value_double`. Measured exactly per source, all six carry values (for example `source_status` on 229,961 of
234,325 release-series observations) and all six are named by a current owner scope for the sources that have them.

So the 39 remaining "empty" columns are **11 sampling-window artifacts, 9 deliberate withholdings (section 4), and
19 columns the store genuinely holds nothing for** — each of the 19 counted exactly as 0 of N, not sampled. The
audit now labels every Part C row `exact` or `sampled window` so this cannot be misread again.

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

1. **The forbidden-name rule stays**, with a **closed list of seven vetted exceptions**: `external_id`,
   `external_record_id`, `publisher_item_id`, `source_date_text`, `content_kind`, `text_extraction_status`,
   `publisher_modified_text`. Each was read on the loaded store before it was listed — the external ids are the
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
to show"*, relayed by the release coordinator after the owner was told that imported figures were being blanked. The
entry says so in `request_source` and repeats it in `not_claimed`: *"The owner has not read this field list field by
field."* The coordinator should put the list in front of the owner before it is mirrored anywhere hosted; mirroring
is what makes it immutable.

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

polls · 12 rows · pollster, sponsor, fieldwork dates and methodology status present · sample_size NULL
poll_results · 144 rows · value_pct NULL, value_status NULL  (see section 4)
```

A vote count is still a number the source reported, never an inference: `value_status` travels with every figure and
a cell the publisher printed no number for reads as its status, never as zero. Nothing is ordered by a figure: the
curated lists offer no figure as a sort key and the generic dataset browser refuses any column whose type is numeric
or whose name is a tally, share, seat count, rank, total or amount (`web/src/lib/generic-sort.ts`, R1).

## 4. Deliberately still withheld — and the rights uncertainty behind each

These are decisions, not oversights. Each is visible in `evidence_public.dataset_columns` with its reason.

| Withheld | Reason | Rights uncertainty, stated |
|---|---|---|
| `poll_results.value_pct`, `polls.sample_size` | No scope kind can carry them, and none was added. | **This is the one real rights uncertainty in the set.** RIGHTS-07 covers "Multiple poll publishers" and is pending and link-only. A pollster's numbers are that pollster's own commercial product, unlike Crown material, so republishing them is a closer call than any other figure here; and 3 of the 12 polls held record `methodology_status = unresolved`. The pollster, sponsor, fieldwork dates, methodology status and the link to the pollster's own page **are** published. If the coordinator or a reviewer takes a different view, it is a new owner entry plus a migration, not a file edit. |
| `poll_results.value_status` | Withheld with the figure. | Showing "a number was reported and is not shown" would be marginally more informative; it was left out to keep the poll set whole, and the reason is published per column in `dataset_columns`. |
| `finance_return_references.approved_total` | It would be a number read from **inside** a return document. Not on any token list, anywhere. | None. Nothing is read from inside a return; the stored records say `amounts_basis = commission_index_page_as_published` and `total_status = not_extracted`, and `total_status` **is** published so the reader is told this plainly. |
| `committee_reports.subtitle`, and the `title`/`label` of any committee report or item of business | 247 of the 1,286 reports are petition reports whose titles name the private person who petitioned (R7); a field decision cannot tell a petition from a briefing. | None, but note the measurement: `subtitle` holds only "Final Report" (1,264) and "Interim Report" (22) today. It is withheld anyway, because the protection is on the file rule, not on today's data. A test refuses any entry that names these fields for a committee source. |
| `identity_decisions.evidence` | Free-form working evidence about a named person; nothing a field decision can check bounds its future contents. | None. The decision, its method and its status are published. |
| Canonical people and parties, bodies, summaries, copied passages, contact details, images, model output | Unchanged from before; `public_withheld` and the R9 row rules were not touched. | None. |

**Gaps that are gaps, not withholdings.** 19 published content columns are empty because the store holds nothing
for them, not because anything is hidden. Each was counted exactly, not sampled:

| Column | Rows | With a value |
|---|---|---|
| `written_questions.answered_on`, `.lodged_on`, `.portfolio` | 187,956 | 0 |
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

## 5. Tests

| What | Where | Result |
|---|---|---|
| pgTAP, whole suite, **against the store holding the real data of all 24 products** | `supabase/tests/*.sql` (18 files) | **607 assertions, all pass** (515 s) |
| pgTAP, whole suite, against a database rebuilt from the migrations (what CI runs) | same | **607 assertions, all pass**; every migration applied from scratch |
| New: figure scopes, from both ends | `supabase/tests/125_public_factual_values.test.sql` | 51 assertions, in both runs |
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

## 6. Exact steps for the coordinator (hosted; none of this was run here)

Nothing below was run against any hosted project by this lane. Run them in this order, as administrator, with the
connection from `PG*` variables and a password file (runbook step 0), and **not while a loader is running**:
`rebuild_exposed_views()` takes exclusive locks and will deadlock against a live import.

1. **Put the field list in front of the owner.** `OWNER-AUTH-2026-09-21-01` was derived from the owner's direction
   by reading the store; the owner has not confirmed it field by field, and the entry says so. Mirroring makes it
   immutable. If anything in it is wider than intended, change it **before** step 4.
2. **Pre-flight, read-only:** `psql -f scripts/db/inspect_existing_objects.sql`; keep the output.
3. **Migration:** confirm `20260921060100_public_factual_values.sql` is the only unapplied file
   (`supabase db push --dry-run`), then `supabase db push`. It is additive: it alters constraints on
   `owner_authorization_scopes`, replaces three functions and one view, and re-runs `classify_public_columns()` and
   `rebuild_exposed_views()`. On a store with every migration applied the readout was `{"open_tables": 89,
   "public_views": 30, "inspector_views": 34, "not_exposed_default_deny": 0}` and `classify_public_columns() = 1133`;
   compare it with the same call before the push rather than with these numbers, because they count objects and a
   hosted store missing an earlier migration will differ. `not_exposed_default_deny` must be 0 either way.
4. **Owner file:** `node tools/owner_authorization.ts` (expect `valid; 85 scope(s) in force today` while all three
   entries are current), then `psql -v ON_ERROR_STOP=1 -f scripts/db/sync_owner_authorizations.sql`. Expect
   `{"recorded": 1, "revoked": 0, "unchanged": 2}`.
5. **Readback, the same script prints it:** gates `closed`, `public_rows_released = t`,
   `release_basis = owner_override`, `rights_rows_not_pending = 0`.
6. **Anonymous audit:** `psql -v ON_ERROR_STOP=1 -f scripts/db/public_value_audit.sql`. Expect Part C to be
   materially shorter than before the change, and Part B to list every one of the 24 products with a non-zero
   `owner_fields`. Read Part C: it is the list of what is still blank, and why.
7. **From outside the database**, with the anon key only: `GET /rest/v1/candidacies?select=candidate_name,votes,votes_status,list_rank&votes=not.is.null&limit=5`
   returns real numbers; `GET /rest/v1/poll_results?select=value_pct&limit=5` returns nulls; `GET /rest/v1/surface_status`
   shows `owner_figure_scopes`; anonymous `POST`/`PATCH`/`DELETE` on both public schemas are refused;
   `evidence_private` and `evidence_views` are unreachable.
8. **Explorer:** `npm run types:check` must pass against the hosted schema's local equivalent before a rebuild;
   redeploy the Pages shell only under the existing `pages_deploy` scope and `PAGES_DEPLOY_ENABLED`.
9. **To withdraw everything in this change at once:** mark `OWNER-AUTH-2026-09-21-01` `revoked` in the file and
   re-run step 4. Every figure and every field it named disappears immediately, with no deployment. Closing either
   release gate is not needed and would not be the right lever: the gates record reviews.

## 7. What nobody has done

No legal review (R10). Nobody has accepted the accountable-person role (R8). No publisher has approved or licensed
anything; all 22 rights rows are `pending` / `link-only`. No security sign-off. No hosted write, deployment, merge
or push was made by this lane. The owner has not confirmed the derived field list field by field.
