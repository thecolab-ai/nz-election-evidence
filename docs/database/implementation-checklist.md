# Implementation checklist

> **Status: NOT complete, NOT released.** Independent review of commit `6b8218e` returned **NO-GO**; this revision addresses its security and CI findings only. Source completeness is unchanged and partial: of the **24** catalogue products, **3** have a live adapter (P01 feed window only, P03, P10), **1** (P04) has an export contract run on the verified upstream product on a local disposable database only, and **20 have no route into the store at all**. Nothing has been pushed, applied to a hosted project, scheduled, deployed or published.

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
- [x] Versioned operator scripts: worker login, Vault secrets, activate/deactivate with readback, inspector grant/revoke, read-only pre-flight
- [ ] Hosted deployment, Vault secrets, schedule activation — **deliberately not done**; awaits release review

## 4. Source freshness

- [x] Freshness table and statuses: fresh, stale, partial, unavailable, reachable_not_parsed, never_run; last attempt, last success, last change, latest publisher date, consecutive failures
- [x] Verified live for nine sources (three fresh, four unavailable, one reachable-not-parsed, one never run); freshness is part of the public projection

## 5. Public read-only access, source rights and the private boundary

Rewritten after the release review (findings 1–3). Public transparency does not waive source rights.

- [x] **Default deny.** An object is projected only if `public_lineage` records how every row resolves, by foreign keys, to exactly one source (or states that it holds no source data); a column only if `public_columns` classifies it. Objects with no provable single-source lineage (canonical people and parties, electorate identities, boundary editions, statistical geographies, the cross-source coverage aggregate) are withheld with a published reason
- [x] **Finding 1 (P0) fixed and regression-tested.** Rights are enforced through the full lineage for every exposed object, including versions, observations, lifecycle events, checkpoints, errors, fetch log, documents and typed descendants, results, lists, links and statistics. The reviewed code leaked a refused source through `source_record_versions` (reproduced before the fix); the pgTAP test now snapshots **every** source-lineage projection before and after seeding refused, restricted, withheld and rights-less sources and requires identical row counts in all of them
- [x] **Finding 2 fixed.** Release tier per source from its rights row: `none` (absent, refused, restricted or default release withheld: nothing shown), `link_only` (pending, or approved for links: identifiers, kinds, official URLs, dates, hashes and statuses only), `fields` (approved **and** release mode approved-fields: a content column or payload key is shown only if named in `approved_fields`). There is no general `safe_payload` release at any tier; pending never releases content even when the register asks for approved-fields; the worker cannot write `approved_fields`. Test: a pending source adds not one non-null content value to any column of any projection
- [x] **Finding 3 fixed.** Every string a record carries is validated at ingest, not only the payload: external identifiers, record kind, links (no userinfo, no secret-bearing query or fragment), publisher date text, omitted-field names and reasons, payload key names at every depth, plus contact, credential, token, connection-string, private-path and control-character patterns. Rejected records are referenced by a digest, never by their identifier. Run error text is redacted before storage and **never published**; nor are ingest error messages, record references, checkpoint JSON, watermarks, worker ids or lifecycle free text. The public sees error classes only. 40 adversarial pgTAP cases and a TypeScript adversarial export test
- [x] Release-gated inside the database (R8 and R10, closed by default); catalogue always readable; model summaries public only after human review of the exact output **and** every input source at the fields tier
- [x] Public roles cannot write; private, base, release, `vault` and `auth` schemas and every function are denied to anonymous and signed-in accounts alike (pgTAP + browser tests); no `SECURITY DEFINER`, no RPC; column-level grants for the public owner role; pooler-safe worker with a scoped login

## 6. Read-only explorer (public, no sign-in)

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
