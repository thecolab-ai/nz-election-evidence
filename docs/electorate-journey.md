# The electorate journey: design and verification

**Status:** implemented on branch `feat/election-overnight-journey`. Not merged, not deployed. Nothing in this
document is a finding about any person or party.

The Evidence Explorer answered "what has this project retrieved?". It did not answer the question an ordinary
reader actually arrives with, which is about one place. This note records what was built to answer that, what the
store could and could not support, and how each claim was checked.

Measurements below were taken on **2026-09-21 (NZ)** by anonymous, read-only requests to the hosted public API,
using the public anon key from `~/.config/nz-election-evidence/hosted-public-config.json`. They describe the hosted
deployment as it stood then, and each will change as loads land.

## 1. What was built

| Address | What it is |
|---|---|
| `/` | The entry point. A name-only electorate picker, the boundary position, what the store holds for 2026, the parties' own policy pages, and three ways into the full register. |
| `/electorate/$slug` | One electorate in one boundary edition: 2026, current representation, dated parliamentary activity, the 2023 election, and money. Shareable by its address. |
| `/overview` | The previous homepage, unchanged. The whole evidence explorer is untouched and still reachable from every page. |

Source: `web/src/routes/home.tsx`, `web/src/routes/electorate.tsx`, `web/src/routes/electorate-data.ts`,
`web/src/lib/electorate.ts`, `web/src/components/fact-card.tsx`, `web/src/components/electorate-picker.tsx`.

## 2. Two rules the code enforces, not just the copy

**Folding is for searching, never for joining.** `foldForSearch` strips case and macrons so that typing `otaki`
finds **Ōtaki**. It is applied only to a reader's own query against a list already fetched from one view, and to
resolving a shared address against this store's own slugs (fourteen of the seventy-two loaded slugs carry a
macron, so a link passed through a client that strips them would otherwise lead nowhere). It is never used to
decide that a row from one publisher describes the same thing as a row from another. `resolveSlug` refuses to
resolve when two electorates fold to the same key.

**An answer that did not arrive is not an answer of zero.** `classify` puts every panel into exactly one of six
states, and `AvailabilityBlock` gives each a different sentence:

| State | What the reader is told |
|---|---|
| `ready` | the rows |
| `none_held` | "Nothing was found, and nothing is claimed about what exists at the publisher. This is unknown, not zero." |
| `not_loaded` (PostgREST `PGRST205`, Postgres `42P01`) | "This part of the store is not on the deployment you are reading… makes no claim either way." |
| `not_answerable` (Postgres `57014`) | "This deployment could not answer the question in the time it allows… Rows may well exist." |
| `failed` | the service's own message, plus "An error is not evidence that no records exist." |
| `loading` | a skeleton with a polite live region |

The `not_loaded` state is not hypothetical: `evidence_public.donation_disclosures` exists in this branch's
migrations and **does not exist on the hosted deployment**, which answers `PGRST205`. The money card renders that
state today and will light up without a code change once the donations import runs.

## 3. Every card carries its provenance

`FactCard` cannot be constructed without a publisher, and always prints **the date the publisher states** and
**the date this project retrieved it** as two separate values — never one substituted for the other — plus the
link to the original and a "what this card does not know" list beside the fact rather than in a page footnote.
A unit test holds this: `web/src/components/journey.test.tsx`.

## 4. What the store could support, and what it could not

Measured live, per electorate (timings are the hosted API's, warm):

| Panel | Route through the store | Result on 2026-09-21 |
|---|---|---|
| Electorate picker | `evidence_public.electorates` | 72 rows, all edition `boundaries-used-2023`, all `boundary_edition_verified: false`, all `electorate_type: 'unverified'` |
| Standing in 2026 | `candidacies` filtered on the `electorate_version_id` foreign key, `election_slug = general-2026` | **0 rows for every electorate.** All 963 loaded candidacies are 2023 |
| 2026 boundaries | `evidence_open.boundary_map_links` → `documents` | 3 published map files (General North Island, General South Island, Māori), retrieved 2026-09-12. **No 2026 electorate row exists** |
| Current representation | `service_terms` filtered on `electorate_name_at_source` | 2 rows for every electorate — the same person from two publishers, as two unresolved source identities |
| Parliamentary activity | `evidence_open.bills.member_identity_id` and `written_questions.asked_by_identity_id`, filtered by the identity ids on those member terms | **0 rows.** Not one bill or written question in the store carries a member identity |
| 2023 result | `candidacies` on `electorate_version_id`, `election_slug = general-2023`; `evidence_open.electorate_result_summaries` on `contest_id` | 495 electorate candidacies across all 72 versions (3–11 each); one completeness summary per contest |
| Money | `donation_disclosures` on `electorate_as_published`; two head counts on `finance_returns` | view absent (`PGRST205`); 492 candidate returns held, **0 of which record which candidacy they belong to** |
| Party policy | `policy_classifications` → `party_identities` → `documents`, all by id | 17 pages, every one `policy_class: 'unknown'`, `classification_basis: 'none'` |

### 4.1 The join this product refuses to make

`service_terms.electorate_version_id` is the column that would carry a reviewed link from a member's term to a
boundary version. **It is null on all 244 loaded member terms.** The only thing connecting a member to an
electorate is the name Parliament prints. All 72 electorate names correspond exactly in both directions (72 of 72
matched; no member text is left over), so the panel is useful — but it is a correspondence between two pieces of
text, and the card says exactly that, in `REPRESENTATION_MATCH_NOTE`, above the rows.

Activity is held to a stricter rule and gets no such fallback. Member names are not even written the same way
across publishers — `Watts, Hon Simon`, `Hon Rachel Brooking`, `Tim Costley` — so a name match there would be a
guess dressed as a record. The panel uses the identity id or it reports that it found nothing.

`evidence_public.documents` cannot be used as a way round this: filtering it on `member_name_at_source` is
cancelled by the hosted statement timeout every time (`57014` after ~3.1s, measured five times, `eq` and `ilike`
alike). That is recorded below as a gap, not worked around.

## 5. Acceptance items, and where each stands

| Required | State |
|---|---|
| Electorate-first homepage, clear first action, no login | Done. Name picker, no sign-in anywhere |
| Shareable electorate page | Done. `/electorate/<slug>`, resolves macron-stripped addresses |
| Who represents it now | Done, disclosed as a text correspondence, both source records shown separately |
| Who is standing in 2026, only if authoritatively evidenced | Honest unavailable. Nothing is loaded; the card says so and says what "officially nominated" and "announced" each mean |
| Dated parliamentary activity with citations | Panel implemented against the evidenced identity link; **currently empty because the store holds no such link**. Honest unavailable, with links to the full document register |
| Activity is not effectiveness | Stated on the card, asserted in unit and journey tests |
| Party promises, separate from parliamentary actions | The parties' own pages, on the homepage, with retrieval dates and an explicit statement that nothing on them has been read or classified |
| Finance and donations with scope and period; party money separate from candidate money | Done. Two labelled kinds, the "a party's return is not a candidate's receipt" sentence, and the measured fact that no return records its candidacy |
| 2023 contextualised separately | Done, on its own card, alphabetical, marked "not a forecast" |
| Publisher, original URL, source date vs retrieval date, known unknowns on every factual card | Done, enforced by `FactCard` and a unit test |
| General vs Māori clear | **Cannot be stated.** All 72 electorates are `electorate_type: 'unverified'`. Both homepage and electorate page say so and link the publisher's separate General and Māori maps |
| No home address or GPS; official lookup link | Done. Name-only input; the Commission's own lookup is linked with the status this project last recorded for it (`official_page_unavailable`, 2026-09-12), so a reader is not sent to a page known to be down without warning |
| 2023 and 2026 boundaries never silently equated; changed electorates labelled | The non-equivalence is stated on both pages. **Which electorates changed cannot be labelled**: no 2026 electorate is loaded |
| Current MPs not presumed 2026 candidates | `NOT_A_CANDIDATE_NOTE` on both the 2026 card and the representation card |
| No fixtures or predictions on live | No fixture data ships in the bundle; `check:bundle` enforces it |
| No ranking, endorsement or score | Candidates are alphabetical everywhere; votes are shown as reported and never order a list; no party totals are computed |
| Poll figures need methodology status | Polls are national, not electorate-scoped, and are deliberately absent from both new pages. The existing explorer keeps them |
| Accessible, keyboard, mobile, restrained typography | ARIA combobox with full keyboard handling and a polite live region; existing type scale and neutral palette reused; responsive at 393px and 1440px |

## 6. What was verified, and how

Run in `web/` against the installed dependency tree:

- `npx tsc --noEmit -p tsconfig.json` — clean. This includes `src/lib/contract.ts`, which fails compilation if any
  column these pages read is renamed, retyped or withheld by a migration.
- `npm test` — **86 tests in 4 files pass** (47 before this change, 39 added).
- `npm run build` — clean.
- `npm run check:bundle` — "routable on Pages; no evidence, private names or privileged key material".
- Every read the two pages issue was rehearsed against the live hosted public API for three electorates
  (`mana`, `te-tai-tokerau`, `epsom`) plus both homepage query sets. All answered `200` except
  `donation_disclosures`, which answered `PGRST205` as described above.

**Not run: the Playwright journey suite.** It needs a local Supabase stack and a browser, and this lane was
instructed not to start either. The specs and their configuration are committed and validated
(`npx playwright test --config playwright.journey.config.ts --list` resolves 24 tests: 12 assertions × phone and
desktop), and CI now runs them. Until a green run exists, the journey coverage is written, not proven.

## 7. The exact missing pieces

Each of these is additive and read-only. None requires a change to what is already published.

1. **A member-to-electorate link.** Populate `service_terms.electorate_version_id` from a reviewed decision, or add
   a public view `evidence_public.electorate_representation` keyed on `electorate_version_id` with the member
   identity, the member name, the party label and the basis of the link. Until then the representation card stays
   a disclosed text correspondence.
2. **Member-scoped activity.** Populate `bills.member_identity_id` and `written_questions.asked_by_identity_id`
   (both are 0/0 today), or add `evidence_public.member_activity(person_identity_id, kind, headline, occurred_on,
   occurred_label, official_url, title)` with an index on `person_identity_id`. The page already reads the
   identity route and will fill in with no code change.
3. **An index or a narrower view for `evidence_public.documents`.** Filtering it on `member_name_at_source` is
   cancelled by the statement timeout, so that column is unusable from the browser today.
4. **2026 electorate versions and a boundary-change label.** A 2026 boundary edition with its electorate rows, and
   a link between a 2023 version and its 2026 successor recording whether the area changed. Without it no page can
   honestly say what a 2026 electorate covers.
5. **Verified electorate type.** `electorate_type` is `'unverified'` for all 72. Until it is verified, no page
   states General or Māori.
6. **A candidacy link on filed returns.** `finance_returns.candidacy_id` is null on all 509 rows, so no candidate
   return can be attributed to an electorate from this store.
7. **The donations import on the hosted deployment.** `donation_disclosures` exists in this branch's migrations and
   not on the hosted project.

## 8. Notes for the reviewer

- `/` is now the journey; `/overview` is the former homepage. Two e2e specs that navigated to `/` for the
  overview were repointed to `/overview` (`e2e/browse.spec.ts`, `e2e/access.spec.ts`).
- `.github/workflows/explorer.yml` gained one command (`npm run e2e:journey`) and one always-on artifact upload
  (`journey-screenshots` from `web/test-results/screens`). Nothing else in CI changed; no required check was
  removed or weakened.
- **R10 applies.** These are new public-facing surfaces. A `REVIEW-REGISTER.md` entry naming who reviewed them,
  when, and against which red lines is required before they go live. This lane did not write one: the register is
  a governance file and outside its scope.
