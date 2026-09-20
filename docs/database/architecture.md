# Evidence store architecture

Status: implemented in this branch and exercised on a disposable local stack only. Nothing here has been applied to a hosted project, deployed, scheduled or published. Release steps are in [runbook.md](runbook.md); progress is in [implementation-checklist.md](implementation-checklist.md).

## Three schemas, one direction of flow

| Schema | Exposed through the REST API? | Holds | Who can read | Who can write |
|---|---|---|---|---|
| `evidence_private` | No | Source registry, rights mirror, run ledger, immutable record versions, civic model, documents, statistics, reviews, summaries, release gates | Scoped server roles only | Ingestion worker (through versioned SQL functions), administrator |
| `evidence_inspector` | Yes | Read-only views over allowlisted columns | Signed-in users **with a current inspector membership**. Everyone else gets zero rows | Nobody |
| `evidence_api` | **No (closed)** | Physically separate published projections | Nobody yet | Gated release function only |

The GitHub Pages explorer is a static shell. It ships no evidence. A visitor who is not signed in sees only the shell; a signed-in user without a membership sees an explanation and zero rows. **A public shell is not public evidence.**

## Access control has two independent layers

1. **SQL grants.** `anon` and `authenticated` hold no privilege on `evidence_private` or `evidence_api`. On `evidence_inspector` they hold `SELECT` on views and `EXECUTE` on one boolean function, nothing else.
2. **Row level security** is enabled on every table with policies only for the scoped server roles, so a mistaken future grant to a browser role still reads and writes nothing.

Memberships live in `evidence_private.app_memberships`, written only by an administrator through `scripts/db/grant_inspector.sql`. Claims inside user-editable auth metadata are ignored (tested). Sign-ups are disabled. There is no RPC that accepts SQL text, table names or column lists; the inspector schema exposes exactly one function, `is_inspector()` (tested).

Roles: `evidence_ingest` (worker; cannot update or delete history, approve identities, touch schedule state, read Vault, open a gate or publish), `evidence_inspector_reader` (owns the views; `SELECT` on an enumerated table list), `evidence_publisher` (gated release functions only). The browser never holds a privileged key: the explorer uses the public anon key only.

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

- Hostname allowlisting does not defend against DNS rebinding of an official domain; the allowlist holds government and parliamentary hosts only.
- Typed projections exist for the MP directory, bills, releases and 2023 baseline candidacies. Tables for finance returns, policies, polls, questions, reports and statistics exist with constraints and inspector views, but have no loader yet (see the checklist).
- Summaries, reviews and the release path are schema and gates only. No summary has been generated and nothing has been published.
