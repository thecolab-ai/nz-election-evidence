# Evidence store architecture

Status: implemented in this branch and exercised on a disposable local stack only. Nothing here has been applied to a hosted project, deployed, scheduled or published. Release steps are in [runbook.md](runbook.md); progress is in [implementation-checklist.md](implementation-checklist.md).

## Schemas and who can read what

| Schema | Exposed through the REST API? | Holds | Who can read | Who can write |
|---|---|---|---|---|
| `evidence_private` | No | Every table: registry, rights mirror, run ledger, immutable record versions, civic model, documents, statistics, reviews, summaries, release gates, memberships | Scoped server roles only | Ingestion worker (through versioned SQL functions), administrator |
| `evidence_views` | No | The single definition of each curated, joined view | Owner roles only | Nobody |
| `evidence_public` | Yes | Curated views for **anonymous** readers: rights-tiered rows, link metadata, approved fields only; plus the always-readable catalogue (`dataset_catalogue`, `dataset_columns`, `surface_status`) | Anyone, read-only. Evidence rows only while the release gates are open | Nobody |
| `evidence_open` | Yes | One projection per domain table with provable source lineage, for **anonymous** readers, same tiers | Anyone, read-only, same gate | Nobody |
| `evidence_inspector` | Yes | The curated views with every column | Signed-in users **with a current inspector membership**; everyone else gets zero rows | Nobody |
| `evidence_api` | No (closed) | Reviewed release batches (for future reviewed summaries) | Nobody yet | Gated release function only |

The explorer is a static shell with no sign-in. It ships no evidence; it reads `evidence_public` and `evidence_open` with the public anon key.

### Default deny, source lineage and release tiers

Public transparency does not waive source rights. Three registers, all published through `evidence_public.dataset_catalogue` and `dataset_columns`, decide what an anonymous reader can see; `rebuild_exposed_views()` generates the projections from them and from nothing else.

1. **`public_lineage` — where do this object's rows come from?** Either a foreign-key path from every row to exactly **one** source (through records, versions, runs, documents, result sets, party lists, identities, datasets or series), or an explicit statement that the object holds no source data (governance and registers). **An object with no entry is not exposed.** Objects whose rows cannot be tied to a single source are withheld with a reason: canonical people and parties, electorate identities, boundary editions, statistical geographies, and the cross-source coverage aggregate (the explorer derives coverage from the rights-filtered sources view instead). A row whose lineage resolves to nothing is not shown.
2. **Release tier of the source** (`evidence_private.source_release`, from the rights row):

| Tier | When | What an anonymous reader gets |
|---|---|---|
| `none` | No rights row; review `refused` or `restricted`; or default release `withheld` | Nothing: no row of that source or of anything descended from it, in any projection |
| `link_only` | Review `pending` (whatever the register's default release says), or approved for links only | Rows with **link metadata** only: identifiers, kinds, official URLs, retrieval and publisher dates, hashes, statuses, counts. Every content column, the payload and publisher identifiers are null |
| `fields` | Review `approved` **and** default release `approved-fields` | As above, plus a content column or payload key **only if its name is in that rights row's `approved_fields`** |

There is no general payload release at any tier. `approved_fields` can be non-empty only on an approved, approved-fields row (check constraint), and the worker role cannot write it. All 19 real rights rows are pending, so today every real source is `link_only`.

3. **`public_columns` — what is each column?** `link` or `content` (with its field token). Operational and project-authored objects are link metadata throughout; elsewhere a column is link metadata only if its name is on a short list in `classify_public_columns()`, and **unknown means content**. An unclassified column is not exposed. `public_withheld` lists columns never shown at any tier, with reasons: account holders; names of individual reviewers, deciders, operators and redaction requesters; working notes; and all operational free text (run error detail, ingest error messages and record references, checkpoint JSON, watermarks, worker ids, lifecycle reasons). The public sees error **classes** only.

pgTAP proves the structure (every object withheld or with lineage; every exposed column classified; nothing withheld projected; every source projection joins the tier and excludes `none`; every projection checks the gates) and the behaviour (row counts in **every** projection unchanged by refused, restricted, withheld and rights-less sources; a pending source adds no non-null content value anywhere; approved fields release exactly the named keys).

Rows also need **both** the `r10_public_surface_review` and `r8_accountable_legal_entity` gates recorded as open (`scripts/db/set_release_gate.sql`); both are closed by default. Model summaries additionally need a human review of the exact output and every input source at the `fields` tier.

### Validation of everything that could be published

Adapters allowlist fields, and the database checks again at `ingest_batch` (`record_violation`): identifier shape, record kind, links without userinfo or secret-bearing parameters, publisher date text, omitted-field names and reasons, payload key names at every depth, and contact, credential, token, connection-string, private-path and control-character patterns in every string. A rejected record is referenced by a digest. Checkpoints and fetch-log URLs are checked the same way; run error text is redacted before storage and is never part of a public projection.

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

- Link-only means the publisher's link is shown, and a publisher's own URL can be descriptive (a member's profile address contains their name). That is what linking is; nothing beyond the publisher's URL is derived from it.
- Field tokens are column and payload-key names, approved per rights row. Approving `title` for a publisher releases that publisher's `title` everywhere it appears; a derived column such as `label` needs its own approval.
- Text validation is pattern-based. It is a second line behind the adapter allowlists, not a guarantee against every possible personal or secret string.
- Table row estimates in the catalogue come from planner statistics and can lag.
- Hostname allowlisting does not defend against DNS rebinding of an official domain; the allowlist holds government and parliamentary hosts only.
- Typed projections exist for the MP directory, bills, releases and 2023 baseline candidacies. Tables for finance returns, policies, polls, questions, reports and statistics exist with constraints and public projections, but have no loader yet (see the checklist).
- Summaries, reviews and the release path are schema and gates only. No summary has been generated and nothing has been published.
