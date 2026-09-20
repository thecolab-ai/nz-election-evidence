# Evidence store architecture

Status: implemented in this branch and exercised on a disposable local stack only. Nothing here has been applied to a hosted project, deployed, scheduled or published. Release steps are in [runbook.md](runbook.md); progress is in [implementation-checklist.md](implementation-checklist.md).

## Schemas and who can read what

| Schema | Exposed through the REST API? | Holds | Who can read | Who can write |
|---|---|---|---|---|
| `evidence_private` | No | Every table: registry, rights mirror, run ledger, immutable record versions, civic model, documents, statistics, reviews, summaries, release gates, memberships | Scoped server roles only | Ingestion worker (through versioned SQL functions), administrator |
| `evidence_views` | No | The single definition of each curated, joined view | Owner roles only | Nobody |
| `evidence_public` | Yes | Curated views for **anonymous** readers, withheld columns removed; plus the always-readable catalogue (`dataset_catalogue`, `dataset_columns`, `surface_status`) | Anyone, read-only. Evidence rows only while the release gates are open | Nobody |
| `evidence_open` | Yes | One projection per domain table for **anonymous** readers, withheld columns removed | Anyone, read-only, same gate | Nobody |
| `evidence_inspector` | Yes | The curated views with every column | Signed-in users **with a current inspector membership**; everyone else gets zero rows | Nobody |
| `evidence_api` | No (closed) | Reviewed release batches (for future reviewed summaries) | Nobody yet | Gated release function only |

The explorer is a static shell with no sign-in. It ships no evidence; it reads `evidence_public` and `evidence_open` with the public anon key.

### No silent omissions

Every column of every domain table is public unless `evidence_private.public_withheld` lists it (or its whole table) **with a reason**; row conditions live in `public_row_rules`, also with a reason. `rebuild_exposed_views()` generates all three exposed schemas from the base views, the tables and those two registers, so an omission cannot happen by forgetting a column. A pgTAP drift test fails if any non-withheld column is missing from its projection, or any withheld column appears in one. The registers themselves are published, so a reader can see what is withheld and why.

Withheld today: the membership table (account holders); names of individual reviewers, deciders, operators and redaction requesters; two free-text working-note columns. Row rules: model summaries and their inputs are public only once a human review of that exact output is recorded (R9). Rows of a source whose rights row is `refused` or `restricted` are hidden from every projection that carries a `source_id`.

Never projected because it is not domain data and is not in these schemas at all: auth accounts, Vault secrets, scheduler and network internals, storage, role passwords. Not stored anywhere, so nothing to project: donor contacts, document bodies, file or archive locations (adapter allowlists plus the database payload guard).

### Release gate inside the database

Anonymous readers receive evidence rows only while **both** `r10_public_surface_review` and `r8_accountable_legal_entity` are recorded as open (`scripts/db/set_release_gate.sql`, which demands an evidence reference and a named person). Both are closed by default, so applying the migrations publishes the catalogue and nothing else. Closing either gate withholds every row at once. All 19 rights rows stay pending: what the store holds is, by construction, the link-and-metadata tier the rights register already allows while pending.

## Access control

1. **SQL grants.** `anon` and `authenticated` hold `SELECT` on views in the exposed schemas and nothing else: no table, no function, no sequence, no write. They hold nothing on `evidence_private`, `evidence_views` or `evidence_api`.
2. **Least-privilege owners.** Public views are owned by `evidence_public_reader`, which holds **column-level** `SELECT` on non-withheld columns only; a withheld column is unreachable even if a view were mis-defined. Inspector and base views are owned by `evidence_inspector_reader` (`SELECT` on an enumerated table list).
3. **Row level security** is enabled on every table with policies only for scoped server roles, so a mistaken future grant to a browser role still reads and writes nothing.
4. **No `SECURITY DEFINER` anywhere** (tested). Membership and gate checks are inline subqueries that run with the view owner's read-only privileges; views are `security_barrier`. There is **no RPC surface**: the exposed schemas contain no function (tested). The earlier membership function was removed in review.

Memberships live in `evidence_private.app_memberships`, written only by an administrator through `scripts/db/grant_inspector.sql`. Claims inside user-editable auth metadata are ignored (tested). Sign-ups are disabled. Other roles: `evidence_ingest` (worker; cannot update or delete history, approve identities, clear a rights row, touch schedule state, read Vault, open a gate or publish) and `evidence_publisher` (gated release functions only).

**Pooler correctness.** The worker connects with a login that is only a member of `evidence_ingest`. Every call is a single autocommit statement; nothing depends on session state (no `SET ROLE`, no session advisory locks, no prepared statements, no temp tables; leases are rows; the one custom setting is transaction-local), so the connection is safe behind a transaction-mode pooler. The CLI refuses to ingest with a superuser, `BYPASSRLS` or `CREATEROLE` login. Membership checks read PostgREST's transaction-local JWT claims.

## Provenance model

- `source_records` is the stable identity `(source_id, external_record_id)`.
- `source_record_versions` is append-only. A version is identified by the SHA-256 of the **canonical allowlisted projection**, so a refresh that changes only the retrieval time creates no version. `original_content_hash` carries an upstream identifier when importing an export; it was computed over the upstream payload and is never described as a hash of this projection.
- `source_observations` records each sighting `(version, run)` separately.
- Two dates are always independent: `source_published_at` (the publisher's own date; null when the source states none, never invented) and `first_retrieved_at` / `observed_at` (when this project fetched it).
- `omitted_fields` lists, by name and reason, what was deliberately left out. Values are never stored.
- A database-side payload guard rejects contact fields, email-like values, bodies, filesystem locations and oversized payloads even if an adapter allowlist were wrong.

## Run ledger

`import_runs` (status, counts, manifest hash, resume link), `run_checkpoints` (append-only cursors), `source_leases` (one live lease per source; expired leases can be taken over and the dead run is marked `abandoned`), `fetch_log` (every attempt, outcome, status, byte count, body hash), `ingest_errors`, `source_freshness`.

| Requirement | Mechanism |
|---|---|
| Deterministic manifest | Config hash + adapter version + mode + allowlist + bounds; no timestamps; same inputs give the same hash |
| Dry run | `cli.ts run <source> --dry-run` fetches and parses for real and writes nothing |
| Pagination | Bills adapter walks fixed-size pages and fails if the publisher total changes mid-walk |
| Retries and backoff | Exponential, jittered, capped, honours `Retry-After`; 401/403/challenge are **not** retried or worked around |
| Overlap prevention | Lease checked by the dispatcher and again by the worker |
| Resumable checkpoints | Written only after a page is durably stored; a checkpoint is resumed at most once so a stale one cannot wedge a source |
| Idempotent replay | Unique `(record, content_hash)` and `(version, run)`; replay inserts 0 versions |
| Append-only history | Triggers reject `UPDATE`/`DELETE` for every role, owner included |
| Corrections | New rows supersede; `corrections` points at the matching `CORRECTIONS.md` entry |
| Tombstones | Only a **successful, complete** snapshot of a `complete_snapshot` source marks absent records; history is kept; reappearance is logged. Feeds never tombstone |
| Unavailable is not empty | `blocked`/`failed`/`partial` runs never tombstone. A safety valve downgrades a run that would drop most of a source |
| Erasure | Administrator-only `redact_version()` blanks one projection, keeps lineage, logs the event |

## Civic model rules enforced by the database

- Facts attach to **source-scoped identities**. A canonical person or party is linked only through an approved `identity_decisions` row with a named reviewer. A name match can file a proposal; a check constraint makes it impossible for one to be an approval. The worker role can insert proposals only.
- A sitting member is not a candidate: the directory projection writes service terms and creates no candidacy.
- A directory sighting yields observation dates only; service start and end dates stay null until an official event source supplies them. A member missing from a complete snapshot gets `observed_absent_at`, not an end date.
- A list member cannot carry an electorate (check constraint).
- Electorate and list candidacies are separate rows; one person may hold both.
- **Announced is not officially nominated.** A candidacy starts as `announced` or `unknown`; `officially_nominated`, `elected` and `not_elected` require a status event whose source class is the Electoral Commission.
- "Independent" is a label on a candidacy, never a registered party.
- **Unknown is not zero.** Votes, poll values, finance totals and statistical values carry an explicit status, and a number is allowed only when the status says it was reported.
- Electorate type stays `unverified` until checked against an official source; boundary editions are versioned, and nothing hardcodes an electorate count.
- Three scopes never merge for display: `primary_2026`, `baseline_2023`, `finance_2025` (plus `current_parliament`, `statistics`, `general`).

## Scheduling

`pg_cron` → `evidence_private.dispatch_ingest()` → `pg_net` → Edge Function `ingest-run`. The function URL and shared secret are read from **Supabase Vault** at dispatch time. The dispatcher accepts only a Supabase project functions endpoint as its target. The function compares the secret in constant time, accepts a configured `source_id` (never a URL), connects through a login that is only a member of `evidence_ingest`, and is bounded to 140 s and 2,000 records. Backfills run from the CLI, outside the function budget.

Migrations schedule nothing. `activate_schedule()` refuses unless it is given a recent successful run that the **deployed function** created in response to an authenticated readback call; a CLI run is not proof. A check constraint prevents `state = 'active'` without that proof and a cron job id.

## Known limits

- A `refused`/`restricted` rights row hides projections that carry a `source_id`. Derived civic tables reach their source through an evidence version, so a refusal there also needs the redaction or takedown path in the runbook.
- Table row estimates in the catalogue come from planner statistics and can lag.
- Hostname allowlisting does not defend against DNS rebinding of an official domain; the allowlist holds government and parliamentary hosts only.
- Typed projections exist for the MP directory, bills, releases and 2023 baseline candidacies. Tables for finance returns, policies, polls, questions, reports and statistics exist with constraints and public projections, but have no loader yet (see the checklist).
- Summaries, reviews and the release path are schema and gates only. No summary has been generated and nothing has been published.
