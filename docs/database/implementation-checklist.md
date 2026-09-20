# Implementation checklist

> **Status: NOT complete, NOT released, NOT security signed off.** Independent reviews of `6b8218e` and `b761023` both returned **NO-GO**; a later revision addressed their bounded findings, and the PR 8 review of `c27f2b0` (changes requested) is dispositioned item by item in [pr8-review-disposition.md](pr8-review-disposition.md). A separate security re-review was interrupted and is **incomplete**, so no security sign-off exists or is claimed. Source completeness is partial: of the **24** catalogue products, **3** have a live adapter (P01 feed window only, P03, P10), **1** (P04, the 2023 candidacy product) imports through a pinned export contract on a local disposable database only, and **20 have no route into the store at all**. Nothing has been pushed, applied to a hosted project, scheduled, deployed or published.

Branch `feat/supabase-evidence-explorer`. Legend: **[x]** done and verified here · **[~]** built, verification partial (reason given) · **[ ]** not done. "Verified" means the command was run in this work and passed; nothing below is claimed without that. All verification used a **disposable local stack**. No hosted project was touched, nothing was pushed, deployed, scheduled or published.

## 1. Repeatable ingestion

- [x] Version-controlled source config with per-source HTTPS host allowlists, scope, snapshot semantics and cadence (`supabase/functions/_shared/sources.config.json`); validation rejects private-looking hosts, non-HTTPS, enabled probes/exports
- [x] Deterministic run manifests (no timestamps; same inputs, same hash) and `plan` command
- [x] Dry run with real fetch and parse, no writes
- [x] Fetch guard: exact-host allowlist, HTTPS only, manual redirect re-checks, IP-literal refusal, time/size bounds, retries with jittered exponential backoff, `Retry-After`, no retry or workaround of 401/403/bot challenges
- [x] Pagination with a consistency check (bills)
- [x] Leases and overlap prevention; expired-lease takeover marks the dead run `abandoned`
- [x] Run ledger, fetch log (body hash, never body), error log
- [x] Resumable checkpoints, written after durable storage; a checkpoint is resumed at most once (liveness bug found and fixed by the integration test)
- [x] Content hashes over the canonical allowlisted projection; timestamp-only refreshes create no version
- [x] Idempotent replay — pgTAP, integration test, and live (122 / 93 / 10 records: 0 new versions on the second run)
- [x] Append-only history enforced by triggers for every role; corrections supersede
- [x] Tombstones only after a successful complete snapshot; feeds never tombstone; reappearance logged; safety valve against mass disappearance
- [x] Endpoint unavailable ≠ no records: blocked/failed/partial runs tombstone nothing (pgTAP + live Electoral Commission receipts)
- [x] Retrieval date and publisher date stored independently; publisher date null when the source states none
- [x] Live adapters with real receipts: Parliament MP directory, current bills, Beehive releases feed
- [x] Availability probes for sources that refused automated requests (nominations, party register, 2023 results, party finance) and for written questions
- [x] Config-based export importer (JSON Lines, per-source field allowlist, drops recorded by name, location never recorded); contract defined for 2023 candidacies
- [x] 2023 candidacy export compatibility: pinned checksum and manifest, closed upstream vocabularies (`party_list` → `list`; official result/list candidate → `officially_nominated` for this validated product only), evidence-checked numbers (genuine zeros kept, collector-default zeros dropped, nothing guessed), whole-file preflight so a bad input writes nothing and skips nothing. Imported locally: 963 = 495 + 468, 963 nomination events, replay 0 new versions, 0 rejected
- [ ] The same import on a hosted project — not done; awaits release review
- [ ] Export contracts for the remaining catalogue products (see reconciliation)
- [ ] Statistics loader (tables, route guard and views exist; no loader)
- [ ] Parsers for nominations, party register, results and finance once a publisher-approved route exists

## 2. Typed schema and migrations

- [x] 13 migrations apply from scratch on a clean local database (`supabase db reset`, re-run after the last change)
- [x] Sources, rights mirror, catalogue/product mapping, run ledger, records, versions, observations, lifecycle events, freshness
- [x] People, source identities, reviewed identity decisions (name match can never approve), parties, aliases, registrations, temporal affiliations
- [x] Elections, boundary editions, electorates and versions, contests, electorate/list candidacies, status events (announced vs officially nominated), party lists and ranks
- [x] Result sets, candidate/party results, nationwide totals, staged unmatched labels; value status so unknown ≠ zero
- [x] MP service terms (sitting MP ≠ candidate; list MP has no electorate; sighting ≠ service date), role terms
- [x] Documents, bills, written questions, committee reports, releases, policy sources, polls, finance return status (no donor columns), relationship links with real foreign keys
- [x] Statistics: datasets, releases (vintages), series, geography versions, observations with suppression status, one-route reconciliation guard
- [x] Rights decisions, model runs, summaries (never auto-approved), review decisions, corrections, release gates, batches, closed release schema
- [x] Withheld register and row-rule register with reasons; generated public, open and inspector layers; published dataset and column catalogue; a description on every table
- [x] Administrator-only redaction path
- [~] Typed projections implemented for MP directory, bills, releases, 2023 candidacies. Other typed tables have constraints and views but no projection yet

## 3. Functions and cron

- [x] Edge Function `ingest-run`: shared-secret auth in constant time, strict body (a source id, never a URL), bounded runtime/records, scoped login, no payloads in responses — type-checked with Deno and **run locally** (401 / 405 / 400 / 404 / 200 paths exercised)
- [x] `pg_cron` → dispatcher → `pg_net` → function, secrets read from Vault, target restricted to a Supabase functions endpoint — **proven locally end to end**, then deactivated (0 cron jobs left)
- [x] Migrations schedule nothing; activation refused without a function readback run; check constraint forbids `active` without proof
- [x] Versioned operator steps: activate/deactivate with readback, inspector grant/revoke, read-only pre-flight (SQL); worker login and Vault secrets through `ingest/src/operator.ts` (hidden input, SCRAM verifier, refuses where logging would capture a parameter)
- [x] Activation and every dispatch also require a rights row, a terms URL, a named person's terms review and a fresh robots.txt check; **no such review exists, so no schedule can activate** (proven locally against a real readback run: refused)
- [ ] Hosted deployment, Vault secrets, schedule activation — **deliberately not done**; awaits release review

## 4. Source freshness

- [x] Freshness table and statuses: fresh, stale, partial, unavailable, reachable_not_parsed, never_run; last attempt, last success, last change, latest publisher date, consecutive failures
- [x] Verified live for nine sources; freshness is part of the public projection. After the PR 8 fixes: one fresh (releases feed), six blocked (one robots.txt disallow, one undocumented endpoint, three bot challenges, one unreadable robots.txt), one reachable-not-parsed, one export-only

## 5. Public read-only access, source rights and the private boundary

Rewritten after the release review (findings 1–3). Public transparency does not waive source rights.

- [x] **Default deny.** An object is projected only if `public_lineage` records how every row resolves, by foreign keys, to exactly one source (or states that it holds no source data); a column only if `public_columns` classifies it. Objects with no provable single-source lineage (canonical people and parties, electorate identities, boundary editions, statistical geographies, the cross-source coverage aggregate) are withheld with a published reason
- [x] **Finding 1 (P0) fixed and regression-tested.** Rights are enforced through the full lineage for every exposed object, including versions, observations, lifecycle events, checkpoints, errors, fetch log, documents and typed descendants, results, lists, links and statistics. The reviewed code leaked a refused source through `source_record_versions` (reproduced before the fix); the pgTAP test now snapshots **every** source-lineage projection before and after seeding refused, restricted, withheld and rights-less sources and requires identical row counts in all of them
- [x] **Finding 2 fixed.** Release tier per source from its rights row: `none` (absent, refused, restricted or default release withheld: nothing shown), `link_only` (pending, or approved for links: identifiers, kinds, official URLs, dates, hashes and statuses only), `fields` (approved **and** release mode approved-fields: a content column or payload key is shown only if named in `approved_fields`). There is no general `safe_payload` release at any tier; pending never releases content even when the register asks for approved-fields; the worker cannot write `approved_fields`. Test: a pending source adds not one non-null content value to any column of any projection
- [x] **Finding 3 fixed.** Every string a record carries is validated at ingest, not only the payload: external identifiers, record kind, links (no userinfo, no secret-bearing query or fragment), publisher date text, omitted-field names and reasons, payload key names at every depth, plus contact, credential, token, connection-string, private-path and control-character patterns. Rejected records are referenced by a digest, never by their identifier. Run error text is redacted before storage and **never published**; nor are ingest error messages, record references, checkpoint JSON, watermarks, worker ids or lifecycle free text. The public sees error classes only. 40 adversarial pgTAP cases and a TypeScript adversarial export test
- [x] **Re-review of `b761023`.** Canonical people and parties were marked withheld while their ids and names still leaked through identities, decisions and graph edges. Chosen fix: **consistent withholding**. `person_id`, `party_id`, `linked_*_name`, `target_*_id`, party aliases and every edge to or from a canonical node are withheld with a published reason until a reviewed multi-source publication path exists; pgTAP proves no projection carries a canonical id or name, with an approved link seeded privately. No rights were approved and no gate was weakened to do it
- [x] Release-gated inside the database (R8 and R10, closed by default); catalogue always readable; model summaries public only after human review of the exact output **and** every input source at the fields tier
- [x] Public roles cannot write; private, base, release, `vault` and `auth` schemas and every function are denied to anonymous and signed-in accounts alike (pgTAP + browser tests); no `SECURITY DEFINER`, no RPC; column-level grants for the public owner role; pooler-safe worker with a scoped login

## 6. Read-only explorer (public, no sign-in)

- [x] Graph nodes are (kind, id): expansion filters on **both** kind and id on each side, the client drops any edge that does not touch the expanded (kind, id), and the cache key includes the kind; collision regression test with one id under two kinds
- [x] Party-identity and electorate-version detail pages; party labels and electorates link to them from Parliament, elections and identity pages; graph nodes link to their own pages; the graph offers only supported start kinds (source identity, party label, electorate version, record version), with open-by-id for link-only sources; a withheld kind cannot be forced through the URL
- [x] Strict URL search: a page sees only what its validator returned. A browser test found that the router merged raw query keys into validated search (an unknown enum reached a read query); fixed with the router's strict search mode
- [x] Realistic mixed-rights fixtures: one approved publisher with an explicit, limited field list (unnamed fields stay blank), one pending, one refused; a test walks every public dataset for pending, refused and canonical content
- [x] Link-only presentation: blank content is explained on the page, each source shows its release tier, coverage is derived from the rights-filtered sources view, withheld operational text is gone from every page
- [x] Anonymous client typed with **generated** Supabase types (`SupabaseClient<Database, 'evidence_public'>`, replacing `SupabaseClient<any>`); page-level row shapes checked against the generated rows at compile time (negative-tested); CI fails on type drift
- [x] Routes: overview by scope (2026 primary, 2023 baseline and 2025 finance always separate), sources and freshness, records with provenance, versions, detail JSON and lifecycle, people and identities, Parliament, elections, documents, finance, statistics, rights, operations, bounded relationship graph (50 edges per expansion, 300 nodes), **datasets and schema** (every table and column, withheld reasons, generic row browser)
- [x] States: not configured, release pending, loading, empty ("not evidence of absence"), error with retry; server pagination, sorting and filters with validated URL parameters
- [x] Compliance: accountability footer and notice on every page; announced vs officially nominated; unknown never rendered as zero; no ordering by votes, no party colours, no scores
- [x] `npm run typecheck`, unit tests, production build, `check:bundle`, browser tests (including a walk of every public dataset for pending-rights content) and Pages-routing tests pass on the clean local stack; exact counts are in the final report for the revision
- [x] Exact pinned versions installed with no deviation (see `web/README.md`)
- [~] Accessibility was built in (landmarks, table semantics, focus, live regions, non-colour signals) and exercised by role-based selectors; no separate automated accessibility audit was run

## 7. CI and Pages

- [x] Findings 4–6 fixed: no connection string in the workflow (the loopback connection for the seeded scoped login is assembled in `ingest/test/local-stack.ts`; tests assert they run as exactly that login, and `EVIDENCE_REQUIRE_INTEGRATION=1` turns a skipped integration test into a failure); the release gate accepts only the exact outcome `APPROVED` from a closed set and any unknown outcome closes every gate; `CODEOWNERS` covers the review register, rights register, migrations, functions, release tools, operator scripts and workflows; build and bundle check share one `VITE_BASE_PATH` and a mismatch fails
- [x] Re-review: the release gate matches a **stable surface id** by normalised exact equality (first code-formatted token of the Surface cell; no substring, prefix or description matching; a row without an id closes every gate); `CODEOWNERS` also covers the application, generated types, manifests and lockfiles; recommended branch-protection checks are documented in [branch-protection.md](branch-protection.md) with build/test requirements kept distinct from deploy approval — **no remote setting was changed**
- [x] All new tooling is TypeScript: ingestion CLI, release gate (`tools/release_gate.ts`), receipt publisher, workflow invariant tests, explorer scripts (types, bundle check, Pages preview). The Python release gate written earlier was replaced; the legacy validators (`scripts/validate.py`, `scripts/red_lines.py`) are unchanged in behaviour
- [x] `.github/workflows/explorer.yml`: least-privilege (`contents: read` globally; `pages: write` + `id-token: write` only on the deploy job), no secrets used, actions pinned by commit, existing compliance checks run first and unchanged
- [x] Deploy needs every CI job, the R10 release gate, the election-day freeze check and an owner switch; gate is currently **closed** (tested)
- [x] Repository base path, SPA refresh fallback and bundle safety checked in the build job; generated database types checked for drift in the database job
- [~] Workflow not executed on GitHub (nothing was pushed). YAML parsed and its invariants are unit-tested; each job's commands were run locally

## 8. Compliance retained

- [x] `scripts/validate.py`, `scripts/red_lines.py --freeze-check` and the existing unit tests pass; the boundary scanner now also covers SQL, TypeScript, TOML and JSON Lines (one narrow exemption: the generated types file's `export type Database`)
- [x] Review register: two new **PENDING** rows (public explorer; evidence store). No approval is claimed
- [x] No credentials, private hostnames, archive locations or response bodies in git; receipts are sanitised and asserted so

## 9. PR 8 review fixes (all verified from scratch on the task-local stack)

Item-by-item evidence is in [pr8-review-disposition.md](pr8-review-disposition.md).

Final run, 2026-09-20, after confirming no other session or process was using the task-local stack: database rebuilt from the 13 migrations; **pgTAP 304/304** (10 files); integration tests **fail rather than skip** without the explicit bootstrap, then ingest + tooling **94/94 with 0 skipped** (17 of them against the database as the scoped login); Deno check; source config valid (9 sources, 1 schedule, inactive); explorer copy scan clean (60 files); generated types match the migrations; web typecheck and **vitest 32/32**; Pages build and bundle check; **browser 25/25**, **Pages routing 4/4**; Python validation, red lines with freeze check and 20 unit tests. Function served locally under the edge runtime: 401 without the secret, 400 with a `url` field, 200 readback; Vault entries set through the operator tool; **activation refused** for want of a terms URL and a person's terms review. Then a second rebuild for clean receipts: one source ran, six blocked, one not parsed; the 963-row import stored 963 and replayed 0. End state: all three gates closed, 0 cron jobs, 0 active schedules, 0 terms reviews, every rights row pending, anonymous readers see 0 evidence rows.

- [x] Fetch guard: one abort signal over headers **and** body, bounded by the run deadline, stream cancelled; adapter headers dropped when a redirect changes origin; forbidden headers stripped
- [x] Publisher access: robots.txt per host (fail closed when unreadable), per-host pacing and Crawl-delay, `access_basis` per source, undocumented endpoints never contacted, spoofed `Origin`/`Referer` removed
- [x] Rights references required for live sources (config and table constraint); two new **pending** rows; recorded robots/terms retrievals as provenance; a person's terms review required before activation and at every dispatch
- [x] No login on any automatic seed path: seed removed, explicit loopback-only bootstrap with tested refusal of remote targets and a server-side socket guard
- [x] Operator secrets: no secret in arguments, output or statement text; SCRAM verifier for the role; Vault value only as a bind parameter after a logging check, otherwise refused
- [x] R1: generic dataset browser never sorts by a figure (type and name, default deny); per-person numeric sorts and the dead people spec removed
- [x] R9: explicit confidence semantics (reported / not reported / not applicable; no invented numbers), model run required for model-made policy classes, human-agreement studies as their own record distinct from per-output review
- [x] Red lines R1/R4 now cover TS/TSX reader-facing copy, with regression and false-positive tests, in CI
- [x] Nits: withheld-table row counts hidden; worker cannot edit an active schedule; https only outside an explicit loopback test build; older workflows SHA-pinned without persisted credentials; register and DDL privilege tests; FORCE RLS evaluated and its premises tested
- [ ] R8 accountable person: **a human gate, not done and not claimed**. The footer says so and the gate stays closed
- [ ] Terms URLs for the Beehive and Electoral Commission rows, every terms review, publisher permission for the MP directory and a documented bills route: **people's work, not done**

## Missing inputs and blocks

1. Reviewed export files for the 2023 baseline and every other catalogue product (and the exporter's stated row counts).
2. A publisher-approved route to Electoral Commission data (the sites refused automated requests from this host), permission or a documented route for the Parliament members listing (robots.txt disallows automated clients), and a documented bills data route (only an internal endpoint was found).
3. A hosted Supabase project reference, administrator connection and release approval.
4. R8 legal entity, R10 reviews and rights decisions — human gates; not something code can satisfy. Release review should also confirm the withheld register and the decision that typed fields (titles, names of public office-holders, party labels, dates) are metadata within the pending link-only tier.
5. Unimplemented adapters and loaders are enumerated, with their blockers, in [source-reconciliation.md](source-reconciliation.md#adapters-and-loaders-that-are-not-implemented).
