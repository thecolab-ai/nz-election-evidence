# Evidence store runbook

Everything operational is a versioned file in this repository: migrations in `supabase/migrations/`, operator scripts in `scripts/db/`, source configuration in `supabase/functions/_shared/sources.config.json`. There is no one-off SQL. If a step is not written here, it is not part of the procedure.

**Hosted-project steps below have NOT been run.** They await coordinator release review.

**Connected release on the owner's authorization (2026-09-20):** the exact hosted sequence for the first release, and what that authorization is and is not, are in [connected-release.md](connected-release.md). It does not replace the reviews in section 3; it is the owner's decision to proceed ahead of them, recorded as a departure from R8 and R10.

## 1. Local development (disposable stack)

Needs Docker, the Supabase CLI (2.113.0 tested) and Node 24. Ports are non-default (API 55321, database 55322).

```bash
supabase start -x studio,imgproxy,storage-api,realtime,logflare,vector,supavisor,postgres-meta,mailpit,edge-runtime
supabase test db                      # pgTAP (11 files)
cd ingest && npm ci
npm run typecheck && npm test         # ingestion + release tooling unit tests (TypeScript, no network)
npm run check:deno                    # Edge Function type-check
node ../tools/red_lines_copy.ts       # R1/R4 wording in explorer copy (TS/TSX strings and JSX text)
# The scoped worker login is NOT created by any seed or migration. Create it on the LOCAL stack explicitly:
node src/local_bootstrap.ts           # random value, SCRAM verifier only, git-ignored owner-only file, expires in 14 days.
                                      # No target option; refuses a remote Docker daemon; the SQL refuses any network session.
EVIDENCE_TEST_LOCAL_STACK=1 EVIDENCE_REQUIRE_INTEGRATION=1 node --test test/integration.test.ts   # asserts the scoped login; a skip is a failure
node src/cli.ts validate
node src/cli.ts plan nz_government_releases_feed           # deterministic manifest; no network, no writes
node src/cli.ts run nz_government_releases_feed --dry-run  # real fetch (robots.txt read and recorded first, paced) and parse; no writes
node src/cli.ts registry-sync                              # sources, rights mirror, schedules (inactive)
node src/cli.ts run nz_government_releases_feed --receipt receipt.json
node src/access_check.ts --record --receipt access.json     # robots.txt and terms-page retrievals, recorded as provenance (not approval)
```

`supabase db reset` rebuilds the local database from the migrations. **`supabase db reset --linked` is forbidden**: it would drop and rebuild a hosted project. There is no seed file and seeding is switched off in `supabase/config.toml`, so no reset of any kind can create a login; CLI runs read the local worker connection from the file the bootstrap writes (`EVIDENCE_INGEST_DB_URL` for anything else comes from the operator's environment, never from git).

The CLI connects as a login that is only a member of `evidence_ingest`, exactly as in production, and refuses a superuser, `BYPASSRLS` or `CREATEROLE` login. It keeps no session state, so the connection string may point at a transaction-mode pooler.

Explorer: `cd web && npm ci && npm run typecheck && npm test && npm run build && npm run check:bundle && npm run e2e && npm run e2e:pages`. After any migration change run `npm run types:generate` (CI runs `types:check`). Changing `[api] schemas` in `supabase/config.toml` needs `supabase stop && supabase start` before the REST gateway sees it.

## 2. Reviewed export imports (backfills)

Large historical loads never run inside the Edge Function. They use the CLI with an export file that stays **outside the repository**:

```bash
export EVIDENCE_EXPORT_BASELINE_2023_CANDIDACIES=<location of the verified candidacies JSON Lines file>
export EVIDENCE_EXPORT_BASELINE_2023_MANIFEST=<location of that capture's manifest.json>
node src/cli.ts import baseline_2023_candidacies_export --dry-run
node src/cli.ts import baseline_2023_candidacies_export --backfill --receipt receipt.json
```

The importer validates the whole file first: pinned checksum and row count, the upstream manifest's checksum and count, required values, closed vocabularies and unique ids. A mismatch stops before a run exists, so nothing is written and no row is skipped. The receipt's `input_findings` lists what was dropped as an upstream default and any ambiguity (for example a contest where every reported figure is zero); read it before relying on the import.

The export location, producing system and any machine name never enter the ledger; the manifest records the file's SHA-256, size and row count. Each source has a field allowlist in its `export_contract`; every other field is dropped and the drop is recorded by name and reason. To add a source: add a contract to the source config, add a reconciliation row to [source-reconciliation.md](source-reconciliation.md), have the exporter state its row count, run the dry run, then the import, and commit the receipt. An interrupted import resumes from its checkpoint.

## 3. Release checklist for a hosted project (not yet run)

Pre-conditions: coordinator release review complete; `REVIEW-REGISTER.md` rows for the evidence store and the explorer addressed; a project backup/restore rehearsed on the chosen plan (do not assume point-in-time recovery is included).

0. **Connecting as administrator:** use the `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` variables with a password file (`PGPASSFILE`) or a connection service, not a URL with a password on a command line: arguments are visible in the process list and in shell history.
1. **Pre-flight, read-only:** `psql -f scripts/db/inspect_existing_objects.sql`. Keep the output. Stop if any `evidence_*` object, policy or cron job already exists unexpectedly.
2. **Migrations:** `supabase link --project-ref <ref>`, `supabase db push --dry-run`, review, then `supabase db push`. Re-run the pre-flight and compare.
3. **API exposure:** in project settings expose `evidence_public`, `evidence_open` and `evidence_inspector` only. Do **not** expose `evidence_private`, `evidence_views` or `evidence_api`. With the gates still closed this publishes the dataset catalogue and no evidence rows. Confirm sign-ups are disabled and the site URL / redirect list contains only the explorer URL.
4. **Worker login:** `node ingest/src/operator.ts set-ingest-login`. The password is typed or pasted at a hidden prompt (or piped on standard input from a password manager); it is never an argument and is never sent to the server, which receives a SCRAM-SHA-256 verifier computed locally. If the server would record the `ALTER ROLE` text and that cannot be switched off for the transaction, the tool stops; `--accept-logged-verifier` proceeds with a 32+ character password, since a log then holds only a salted hash. Verify the printed readback: no superuser, no bypass of row level security, member of `evidence_ingest` only.
5. **Function secrets:** `supabase secrets set EVIDENCE_INGEST_DB_URL=... EVIDENCE_CRON_SECRET=...` (values from the operator's shell; 32+ characters for the cron secret). **Deploy:** `supabase functions deploy ingest-run` (JWT verification is off for this function by design; it authenticates the scheduler's shared secret).
6. **Registry:** `node src/cli.ts registry-sync` with the worker connection. Schedules arrive **inactive**.
7. **Live role checks** (repeat the boundary tests against the hosted project): with gates closed an anonymous `GET /rest/v1/records` returns `[]` and `dataset_catalogue` returns rows; anonymous `POST`/`PATCH`/`DELETE` are refused on both public schemas; `evidence_private`, `evidence_views`, `vault` and `auth` are unreachable; a withheld column such as `identity_decisions.decided_by` or `import_runs.error_detail` does not exist publicly; with gates open a pending source returns `safe_payload = null` and null content columns; an ordinary signed-in user gets zero inspector rows and `my_access.is_inspector = false`.
8. **Vault:** `node ingest/src/operator.ts set-cron-secrets --functions-base-url https://<project-ref>.supabase.co/functions/v1`, cron secret at the hidden prompt. The value travels only as a bind parameter, and only after the tool has confirmed that no logging setting in force (`log_statement`, duration logging, `log_parameter_max_length`, parameter logging on error, pgaudit) would record parameters. **If one would, the tool refuses and sends nothing**; set the two entries in the dashboard's Vault page instead. Output shows entry names and timestamps only.
9. **Function readback (deployment proof):** call the deployed function once per source with the secret and `"trigger_kind": "function_readback"`. Expect HTTP 200 and a `run_id`; without the secret expect 401; with a `url` field expect 400.
9a. **Publisher access, per source, before any activation:** run `node src/access_check.ts --record` so the robots.txt and terms-page retrievals are on record, and make sure the rights register row names the publisher's terms URL where one can be verified. Collection is limited to read-only pages and endpoints served to the anonymous public (owner collection policy, 2026-09-20): a source behind a sign-in or a paywall can never be enabled. robots.txt, an undocumented public endpoint, a missing terms URL and a missing terms review are **advisories**: they do not stop activation, they are shown to you first and stored with it. A person who has read the terms may record the conclusion in `evidence_private.publisher_terms_reviews` (administrator only; nothing in this repository writes that row). A recorded `not_permitted` **does** stop the source everywhere (RED-LINES R6). A recorded retrieval is provenance, not approval, and none of this is a right to publish.
10. **Activate one schedule at a time:** `scripts/db/activate_schedule.sql` with that `run_id`. It first prints the source's blocker (if any) and every access advisory: read them, because activating is your decision and the advisories are copied into the activation proof under your name. The database refuses without a successful readback run from the last 24 hours, without Vault secrets, without a named activator, for a source that is not a public unauthenticated endpoint, and where a terms review says `not_permitted`. The blocker test runs again at **every dispatch** (`skipped_access_not_permitted`). An active schedule's configuration is frozen: deactivate before changing it. Check the readback table: desired state and the real `cron.job` row must agree. Watch the first scheduled run in the explorer (Operations) before activating the next.
11. **Inspectors:** invite the user in Supabase Auth, then `scripts/db/grant_inspector.sql` with a reason.
12. **Open the public gates (only after R8 and R10 are recorded):** `scripts/db/set_release_gate.sql` once per gate, with the evidence reference and the deciding person. Readback must show `public_rows_released = t`. `-v close=1` withholds everything again at once. **Never open a gate on the strength of an owner decision:** a gate records a review. The owner's decision has its own record and its own script, below.
12a. **Owner authorization (a different thing from step 12):** `node tools/owner_authorization.ts`, then as administrator `psql -v ON_ERROR_STOP=1 -f scripts/db/sync_owner_authorizations.sql` from the repository root. It mirrors `governance/owner-authorizations.json`; it opens no gate and approves no rights row, and its readback shows that (`release_basis = owner_override`, gates `closed`, `rights_rows_not_pending = 0`). To withdraw, mark the entry `revoked` in the file and run it again. **An entry is mirrored once and never edited:** if a sync reports `differs from what was recorded`, the file was changed after it was mirrored; revoke that id in the file and record a new one.
12b. **What an anonymous reader actually receives:** `psql -v ON_ERROR_STOP=1 -f scripts/db/public_value_audit.sql`. Every measurement in it is taken with `set role anon`, so it is the anonymous view and nothing else. Part A is every dataset column by column, Part B is every catalogue product source by source, Part C is the gaps stated as gaps. Read Part C before saying a product is published: a projection whose content columns are all null is loaded, not published.
13. **Explorer:** set repository variables `EXPLORER_SUPABASE_URL` and `EXPLORER_SUPABASE_ANON_KEY` (public anon or publishable key only; the build refuses any other role and `check:bundle -- --require-connected` fails the release on anything privileged, on a key from another project, or on an unconnected build). Deployment additionally needs `PAGES_DEPLOY_ENABLED=true` and either an approved `REVIEW-REGISTER.md` row or, while that row is PENDING, a current owner decision with the `pages_deploy` scope (logged as an owner override, never as a review).

## 4. Operating

- **Freshness:** explorer → Sources. `unavailable` means the publisher refused or failed; it does not mean the source is empty. `reachable_not_parsed` means the page answered and nothing is imported. `stale` means no success within twice the expected cadence.
- **A blocked publisher** (401/403, sign-in page, paywall, bot challenge): do nothing clever. No cookies, tokens, browser sessions, impersonating headers or alternative routes. The run is recorded, nothing is tombstoned, the next scheduled attempt tries again. Persistent blocks need a publisher-approved route.
- **Tombstone safety valve:** a complete snapshot that would drop more than half of a source's live records is downgraded to `partial` with `tombstone_safety_valve`, and needs a human look before anything is marked absent.
- **Stuck lease:** leases expire by themselves (run budget + 30 s). The next run takes over and marks the dead run `abandoned`.
- **Rotation:** re-run `operator.ts set-ingest-login` and `operator.ts set-cron-secrets` with new values, update the function secrets, then call the readback.
- **Pause everything** (election-day freeze, incident): `activate_schedule.sql -v deactivate=1` for each schedule; confirm `cron.job` holds no `evidence_private` command.
- **Record a publisher's approval:** update `catalogue/rights-register.json` (owner-reviewed) and sync it **as administrator** with the row's `approved_fields`; the worker role can only ever write pending rows. Content stays blank until then. To withdraw, set the row to `restricted` or `refused`: everything descended from that source disappears from every projection at once.
- **After a schema change:** record lineage in `public_lineage` (or withhold the object), run `select evidence_private.classify_public_columns()`, review the classes, run `select evidence_private.rebuild_exposed_views()`, then `npm run types:generate`. pgTAP fails on any drift.
- **Withdraw the owner's authorization:** set `"status": "revoked"`, `revoked_on` and `revoked_reason` on the entry in `governance/owner-authorizations.json`, commit, run `scripts/db/sync_owner_authorizations.sql`. Rows, fields and figures shown on it are withheld at once. It also lapses by itself on `expires_on`; to continue, record a new entry with a new id (an entry is never edited).
- **Show a figure the store already holds:** it needs a scope of the right kind in a new owner entry, and nothing else. `source_fields` cannot carry a figure and never will. If the column's name is not on the closed token list of `official_result_figures`, `official_finance_figures` or `statistical_facts`, or the source's registry product is not on that scope's allowlist, it takes a **migration**, reviewed as one. See [publication-policy.md](publication-policy.md#published-figures-owner-direction-of-2026-09-21) for the lists and for what stays out on purpose.
- **Revoke an inspector:** `grant_inspector.sql -v revoke=1`.
- **Correction:** log it in `CORRECTIONS.md` within the hour, then add a `corrections` row that points at the entry. Never edit history.
- **Erasure / takedown:** withdraw any published copy first, then `select evidence_private.redact_version('<version id>', '<reason with reference>', '<requester>')` as administrator. The row and lineage remain; the projection is blanked and the action logged.

## 5. Rollback

Migrations are additive. To take the store out of service without losing the audit trail: deactivate schedules, remove `evidence_inspector` from the exposed schemas, revoke memberships, rotate the worker password. Dropping the three schemas is a destructive, owner-only decision and is deliberately not scripted.
