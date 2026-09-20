# Evidence store runbook

Everything operational is a versioned file in this repository: migrations in `supabase/migrations/`, operator scripts in `scripts/db/`, source configuration in `supabase/functions/_shared/sources.config.json`. There is no one-off SQL. If a step is not written here, it is not part of the procedure.

**Hosted-project steps below have NOT been run.** They await coordinator release review.

## 1. Local development (disposable stack)

Needs Docker, the Supabase CLI (2.113.0 tested) and Node 24. Ports are non-default (API 55321, database 55322).

```bash
supabase start -x studio,imgproxy,storage-api,realtime,logflare,vector,supavisor,postgres-meta,mailpit,edge-runtime
supabase test db                      # pgTAP: 144 assertions
cd ingest && npm ci
npm run typecheck && npm test         # unit tests, scripted publisher, no network
npm run check:deno                    # Edge Function type-check
export EVIDENCE_INGEST_DB_URL="postgresql://postgres:postgres@127.0.0.1:55322/postgres"   # local CLI default only
EVIDENCE_TEST_DB_URL="$EVIDENCE_INGEST_DB_URL" node --test test/integration.test.ts
node src/cli.ts validate
node src/cli.ts plan nz_parliament_current_bills           # deterministic manifest; no network, no writes
node src/cli.ts run nz_parliament_current_bills --dry-run  # real fetch and parse; no writes
node src/cli.ts registry-sync                              # sources, rights mirror, schedules (inactive)
node src/cli.ts run nz_parliament_current_bills --receipt receipt.json
```

`supabase db reset` rebuilds the local database from the migrations. **Never run it against a linked hosted project.** `supabase/seed.sql` is local-only (it lets the local migration role act as the worker).

The CLI drops to the `evidence_ingest` role on connect (`--assume-role none` to disable), so local runs exercise the same privileges as production.

## 2. Reviewed export imports (backfills)

Large historical loads never run inside the Edge Function. They use the CLI with an export file that stays **outside the repository**:

```bash
export EVIDENCE_EXPORT_BASELINE_2023_CANDIDACIES=<location of the reviewed JSON Lines export>
node src/cli.ts import baseline_2023_candidacies_export --dry-run
node src/cli.ts import baseline_2023_candidacies_export --backfill --receipt receipt.json
```

The export location, producing system and any machine name never enter the ledger; the manifest records the file's SHA-256, size and row count. Each source has a field allowlist in its `export_contract`; every other field is dropped and the drop is recorded by name and reason. To add a source: add a contract to the source config, add a reconciliation row to [source-reconciliation.md](source-reconciliation.md), have the exporter state its row count, run the dry run, then the import, and commit the receipt. An interrupted import resumes from its checkpoint.

## 3. Release checklist for a hosted project (not yet run)

Pre-conditions: coordinator release review complete; `REVIEW-REGISTER.md` rows for the evidence store and the explorer addressed; a project backup/restore rehearsed on the chosen plan (do not assume point-in-time recovery is included).

1. **Pre-flight, read-only:** `psql "$ADMIN_DB_URL" -f scripts/db/inspect_existing_objects.sql`. Keep the output. Stop if any `evidence_*` object, policy or cron job already exists unexpectedly.
2. **Migrations:** `supabase link --project-ref <ref>`, `supabase db push --dry-run`, review, then `supabase db push`. Re-run the pre-flight and compare.
3. **API exposure:** in project settings expose `evidence_inspector` only. Do **not** expose `evidence_private` or `evidence_api`. Confirm sign-ups are disabled and the site URL / redirect list contains only the explorer URL.
4. **Worker login:** `scripts/db/create_ingest_login.sql` with a freshly generated password. Verify the readback row: no superuser, no bypass of row level security, member of `evidence_ingest` only.
5. **Function secrets:** `supabase secrets set EVIDENCE_INGEST_DB_URL=... EVIDENCE_CRON_SECRET=...` (values from the operator's shell; 32+ characters for the cron secret). **Deploy:** `supabase functions deploy ingest-run` (JWT verification is off for this function by design; it authenticates the scheduler's shared secret).
6. **Registry:** `node src/cli.ts registry-sync` with the worker connection. Schedules arrive **inactive**.
7. **Live role checks** (repeat the pgTAP boundary by hand against the hosted project): anon REST call to `/rest/v1/records` is refused; an ordinary signed-in user gets zero rows and `is_inspector = false`; an inspector reads; an inspector `PATCH`/`POST`/`DELETE` is refused; `evidence_private` is not reachable through REST.
8. **Vault:** `scripts/db/set_cron_vault_secrets.sql`. Readback shows names only.
9. **Function readback (deployment proof):** call the deployed function once per source with the secret and `"trigger_kind": "function_readback"`. Expect HTTP 200 and a `run_id`; without the secret expect 401; with a `url` field expect 400.
10. **Activate one schedule at a time:** `scripts/db/activate_schedule.sql` with that `run_id`. The database refuses without a successful readback run from the last 24 hours. Check the readback table: desired state and the real `cron.job` row must agree. Watch the first scheduled run in the explorer (Operations) before activating the next.
11. **Inspectors:** invite the user in Supabase Auth, then `scripts/db/grant_inspector.sql` with a reason.
12. **Explorer:** set repository variables `EXPLORER_SUPABASE_URL` and `EXPLORER_SUPABASE_ANON_KEY` (public anon key only). Deployment additionally needs an approved `REVIEW-REGISTER.md` row and `PAGES_DEPLOY_ENABLED=true`.

## 4. Operating

- **Freshness:** explorer → Sources. `unavailable` means the publisher refused or failed; it does not mean the source is empty. `reachable_not_parsed` means the page answered and nothing is imported. `stale` means no success within twice the expected cadence.
- **A blocked publisher:** do nothing clever. The run is recorded, nothing is tombstoned, the next scheduled attempt tries again. Persistent blocks need a publisher-approved route.
- **Tombstone safety valve:** a complete snapshot that would drop more than half of a source's live records is downgraded to `partial` with `tombstone_safety_valve`, and needs a human look before anything is marked absent.
- **Stuck lease:** leases expire by themselves (run budget + 30 s). The next run takes over and marks the dead run `abandoned`.
- **Rotation:** re-run `create_ingest_login.sql` and `set_cron_vault_secrets.sql` with new values, update the function secrets, then call the readback.
- **Pause everything** (election-day freeze, incident): `activate_schedule.sql -v deactivate=1` for each schedule; confirm `cron.job` holds no `evidence_private` command.
- **Revoke an inspector:** `grant_inspector.sql -v revoke=1`.
- **Correction:** log it in `CORRECTIONS.md` within the hour, then add a `corrections` row that points at the entry. Never edit history.
- **Erasure / takedown:** withdraw any published copy first, then `select evidence_private.redact_version('<version id>', '<reason with reference>', '<requester>')` as administrator. The row and lineage remain; the projection is blanked and the action logged.

## 5. Rollback

Migrations are additive. To take the store out of service without losing the audit trail: deactivate schedules, remove `evidence_inspector` from the exposed schemas, revoke memberships, rotate the worker password. Dropping the three schemas is a destructive, owner-only decision and is deliberately not scripted.
