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

- [x] 12 migrations apply from scratch on a clean local database (`supabase db reset`, `supabase migration up`)
- [x] Sources, rights mirror, catalogue/product mapping, run ledger, records, versions, observations, lifecycle events, freshness
- [x] People, source identities, reviewed identity decisions (name match can never approve), parties, aliases, registrations, temporal affiliations
- [x] Elections, boundary editions, electorates and versions, contests, electorate/list candidacies, status events (announced vs officially nominated), party lists and ranks
- [x] Result sets, candidate/party results, nationwide totals, staged unmatched labels; value status so unknown ≠ zero
- [x] MP service terms (sitting MP ≠ candidate; list MP has no electorate; sighting ≠ service date), role terms
- [x] Documents, bills, written questions, committee reports, releases, policy sources, polls, finance return status (no donor columns), relationship links with real foreign keys
- [x] Statistics: datasets, releases (vintages), series, geography versions, observations with suppression status, one-route reconciliation guard
- [x] Rights decisions, model runs, summaries (never auto-approved), review decisions, corrections, release gates, batches, closed published schema
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
- [x] Verified live for nine sources (three fresh, four unavailable, one reachable-not-parsed, one never run)

## 5. Access boundary

- [x] Private schema unexposed; inspector views gated by server-side membership; published schema closed
- [x] pgTAP allow/deny: anon denied everywhere; ordinary signed-in user zero rows; metadata role claims ignored; revoked membership denied; inspector reads via views only; every browser mutation denied; worker cannot rewrite history, approve identities, read Vault, activate schedules, open gates or publish
- [x] Structural tests: RLS on every table, no browser grants on private/published schemas, every view is a security barrier owned by the read-only role and filters on membership, no RPC other than `is_inspector()`
- [x] Rights rows stay pending; release refuses pending rights even with gates open; summaries need a human review of the exact output hash

## 6. Read-only explorer

See `web/README.md` for the exact commands and results recorded by the explorer build.

- [ ] Status to be filled from the explorer build report (typecheck, unit tests, build, browser tests, Pages routing)

## 7. CI and Pages

- [x] `.github/workflows/explorer.yml`: least-privilege (`contents: read` globally; `pages: write` + `id-token: write` only on the deploy job), no secrets used, actions pinned by commit, existing compliance checks run first and unchanged
- [x] Deploy needs every CI job, the R10 release gate, the election-day freeze check and an owner switch; gate is currently **closed** (tested)
- [x] Repository base path and SPA refresh fallback checked in the build job
- [~] Workflow not executed on GitHub (nothing was pushed). YAML parsed and its invariants are unit-tested; each job's commands were run locally

## 8. Compliance retained

- [x] `scripts/validate.py`, `scripts/red_lines.py --freeze-check` and the existing unit tests pass; the boundary scanner now also covers SQL, TypeScript, TOML and JSON Lines
- [x] Review register: two new **PENDING** rows (explorer; evidence store). No approval is claimed
- [x] No credentials, private hostnames, archive locations or response bodies in git; receipts are sanitised and asserted so

## Missing inputs and blocks

1. Reviewed export files for the 2023 baseline and every other catalogue product (and the exporter's stated row counts).
2. A publisher-approved route to Electoral Commission data (the sites refused automated requests from this host).
3. A hosted Supabase project reference, administrator connection and release approval.
4. R8 legal entity, R10 reviews and rights decisions — human gates; not something code can satisfy.
