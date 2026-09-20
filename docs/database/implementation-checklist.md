# Implementation checklist

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
- [ ] Export imports actually run — **missing input**: no reviewed export file was supplied
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
- [x] Versioned operator scripts: worker login, Vault secrets, activate/deactivate with readback, inspector grant/revoke, read-only pre-flight
- [ ] Hosted deployment, Vault secrets, schedule activation — **deliberately not done**; awaits release review

## 4. Source freshness

- [x] Freshness table and statuses: fresh, stale, partial, unavailable, reachable_not_parsed, never_run; last attempt, last success, last change, latest publisher date, consecutive failures
- [x] Verified live for nine sources (three fresh, four unavailable, one reachable-not-parsed, one never run); freshness is part of the public projection

## 5. Public read-only access and the private boundary

- [x] Anonymous read-only projection of **every** domain table (`evidence_open`) and of every curated view (`evidence_public`); any withheld table, column or row carries a published reason; pgTAP drift test proves there is no silent omission and that no withheld column is exposed
- [x] Release-gated inside the database: no evidence rows for the public until R8 and R10 are recorded as open (closed by default); the catalogue is always readable; closing a gate withholds everything at once; a `refused`/`restricted` rights row hides that source
- [x] Public roles cannot write: `SELECT` on views only; every write verb refused through REST and through the app's own client (pgTAP + browser tests)
- [x] Denied to anonymous and to signed-in accounts alike: `evidence_private`, `evidence_views`, `evidence_api`, `vault`, `auth`, every function; inspector rows need a current server-side membership; metadata role claims ignored; revoked membership denied
- [x] Security review applied: the `SECURITY DEFINER` membership function was **removed**; no definer function and no RPC exist in any evidence schema (tested); views are `security_barrier`; public views are owned by a role with **column-level** grants on non-withheld columns only
- [x] Pooler correctness: no session state anywhere in the worker path (no `SET ROLE`, advisory locks, prepared statements or temp tables); scoped login everywhere including tests and CI; the CLI refuses elevated logins
- [x] Worker cannot rewrite history, approve identities, clear a rights row, read Vault, activate schedules, open gates or publish
- [x] Rights rows stay pending; release refuses pending rights even with gates open; summaries are public only after a human review of the exact output hash

## 6. Read-only explorer (public, no sign-in)

- [x] Anonymous client typed with **generated** Supabase types (`SupabaseClient<Database, 'evidence_public'>`, replacing `SupabaseClient<any>`); page-level row shapes checked against the generated rows at compile time (negative-tested); CI fails on type drift
- [x] Routes: overview by scope (2026 primary, 2023 baseline and 2025 finance always separate), sources and freshness, records with provenance, versions, detail JSON and lifecycle, people and identities, Parliament, elections, documents, finance, statistics, rights, operations, bounded relationship graph (50 edges per expansion, 300 nodes), **datasets and schema** (every table and column, withheld reasons, generic row browser)
- [x] States: not configured, release pending, loading, empty ("not evidence of absence"), error with retry; server pagination, sorting and filters with validated URL parameters
- [x] Compliance: accountability footer and notice on every page; announced vs officially nominated; unknown never rendered as zero; no ordering by votes, no party colours, no scores
- [x] `npm run typecheck`, 18 unit tests, production build, `check:bundle`, 20 browser tests, 4 Pages-routing tests — all passing on the clean local stack
- [x] Exact pinned versions installed with no deviation (see `web/README.md`)
- [~] Accessibility was built in (landmarks, table semantics, focus, live regions, non-colour signals) and exercised by role-based selectors; no separate automated accessibility audit was run

## 7. CI and Pages

- [x] All new tooling is TypeScript: ingestion CLI, release gate (`tools/release_gate.ts`), receipt publisher, workflow invariant tests, explorer scripts (types, bundle check, Pages preview). The Python release gate written earlier was replaced; the legacy validators (`scripts/validate.py`, `scripts/red_lines.py`) are unchanged in behaviour
- [x] `.github/workflows/explorer.yml`: least-privilege (`contents: read` globally; `pages: write` + `id-token: write` only on the deploy job), no secrets used, actions pinned by commit, existing compliance checks run first and unchanged
- [x] Deploy needs every CI job, the R10 release gate, the election-day freeze check and an owner switch; gate is currently **closed** (tested)
- [x] Repository base path, SPA refresh fallback and bundle safety checked in the build job; generated database types checked for drift in the database job
- [~] Workflow not executed on GitHub (nothing was pushed). YAML parsed and its invariants are unit-tested; each job's commands were run locally

## 8. Compliance retained

- [x] `scripts/validate.py`, `scripts/red_lines.py --freeze-check` and the existing unit tests pass; the boundary scanner now also covers SQL, TypeScript, TOML and JSON Lines (one narrow exemption: the generated types file's `export type Database`)
- [x] Review register: two new **PENDING** rows (public explorer; evidence store). No approval is claimed
- [x] No credentials, private hostnames, archive locations or response bodies in git; receipts are sanitised and asserted so

## Missing inputs and blocks

1. Reviewed export files for the 2023 baseline and every other catalogue product (and the exporter's stated row counts).
2. A publisher-approved route to Electoral Commission data (the sites refused automated requests from this host).
3. A hosted Supabase project reference, administrator connection and release approval.
4. R8 legal entity, R10 reviews and rights decisions — human gates; not something code can satisfy. Release review should also confirm the withheld register and the decision that typed fields (titles, names of public office-holders, party labels, dates) are metadata within the pending link-only tier.
5. Unimplemented adapters and loaders are enumerated, with their blockers, in [source-reconciliation.md](source-reconciliation.md#adapters-and-loaders-that-are-not-implemented).
