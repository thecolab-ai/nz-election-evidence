# Connected release on the owner's authorization

This is project process documentation, not legal advice.

> **Read this first.** On 2026-09-20 the repository owner decided to deploy the explorer to GitHub Pages, connected to the hosted database, with real imported data, **ahead of** the independent legal review (R10), **ahead of** anyone accepting the accountable-person role (R8), and **without** any publisher having approved or licensed anything. That is a **departure from RED-LINES R10 and R8 as written** (they allow no exceptions). It is recorded as exactly that, in [`governance/owner-authorizations.json`](../../governance/owner-authorizations.json), entry `OWNER-AUTH-2026-09-20-01`. `RED-LINES.md` is not amended, every `REVIEW-REGISTER.md` row stays **PENDING** with nobody appointed, all 21 rights rows stay **pending / link-only**, and security is **not** signed off. Nothing in this repository says otherwise, and nothing should be read as a reviewer, a lawyer or a publisher agreeing.
>
> **State of this work:** implemented and tested on a local disposable database. **Nothing has been pushed, merged, deployed, or written to a hosted project.** The hosted steps in section 5 are for the coordinator, after an independent readiness review.

## 1. Three decisions that are kept apart

| Question | Who can answer it | Where it is recorded | What the owner decision did to it |
|---|---|---|---|
| Has this surface had its independent legal review (R10)? Has a named person accepted accountability (R8)? | A reviewer; the accountable person | `REVIEW-REGISTER.md`; database `release_gates` | **Nothing.** Rows stay PENDING; both gates stay `closed`. |
| Has the publisher allowed this field to be republished? | The publisher, recorded by a person | `catalogue/rights-register.json` → `source_rights`; tier `none / link_only / fields` | **Nothing.** Every row stays pending; every real source stays `link_only`. |
| Does the owner choose to publish anyway, and exactly what? | The repository owner | `governance/owner-authorizations.json` → `owner_authorizations`, `owner_authorization_scopes` | This is the only thing that changed. |

The mechanisms read the third record **beside** the first two and never write to them:

- **Pages deployment.** `tools/release_gate.ts --surface-id explorer-pages` is unchanged and stays closed. The workflow calls it with `--allow-owner-override`, which opens only when the register row is exactly PENDING **and** a valid, current `pages_deploy` scope names `explorer-pages`. The log line reads `RELEASE GATE OPEN BY OWNER OVERRIDE (NOT A REVIEW)`. A `REJECTED` or `WITHDRAWN` review, an unknown outcome, a malformed register, a malformed owner file, a lapsed or revoked decision, or any other surface: closed. The election-day freeze check still runs first.
- **Rows.** Anonymous projections release rows when both gates are open **or** a current `public_rows` decision exists. `evidence_public.surface_status` reports `release_basis` as `reviews_recorded`, `owner_override` or `none`, with the decision id, date, expiry and request source; the gates keep reading `closed`.
- **Fields.** `source_release.tier` is computed from the rights row exactly as before. A new, separate column `owner_fields` lists the field names a current decision names **for that one source**; it is empty whenever the tier is `none`, so a refused, restricted or withheld publisher stays invisible whatever the owner says, and a field decision against such a row is rejected when it is recorded. There is no wildcard and no general payload release: the payload is filtered key by key. Model summaries are untouched (they still need the publisher `fields` tier and a human review).
- **Every page says so.** While the database reports that rows are released on the owner's decision **or** that any field is shown on it (`owner_fields_in_force`, which stays true even if the reviews are recorded later), the shell shows a notice on every page: owner's decision, its id and dates, which reviews are not yet on record (read from the gate states, not assumed), no publisher approval of the fields shown, links to the decision file and the review register. Each source page lists the fields shown on the owner's decision "not on the publisher's approval". The footer still says the accountable person is not confirmed.
- **The file is the whole truth.** Each sync carries the whole file. The same id with different content is refused (a decision is superseded by a new id, never rewritten, in either direction); a decision in force in the database but missing from the file is refused (mark it revoked instead of deleting it); an entry without a valid status is refused. Dates are compared in UTC on both sides.
- **A publisher's "no" cannot be undone by the worker.** Found in review of this change and fixed in the same migration: the ingest worker's registry sync could reset a refused, restricted or withheld rights row to pending, or move a source to another rights row. While the gates were the only release path that was harmless; with an owner decision it would have put a restricted source back in view. Such rows are now changeable by an administrator only (the worker's sync leaves them as they are, with a warning, and carries on).
- **It lapses and can be pulled at once.** A decision is in force for at most 90 days (this one: until **2026-11-06**, the day before election day; see section 6), is never edited, and is revoked by changing `status` in the file and re-running the sync: every row and field shown on it disappears immediately, with no deployment.

## 2. Source-specific field publication decisions

Without field decisions the connected site would show identifiers, hashes and dates and no names: an empty dashboard. With a false rights approval it would show names and misstate the publisher's position. The honest route is the one taken: **the owner decides, per source and per field, and the site says it is the owner's decision.** No licence is asserted for any of these.

| Source (rights row, still pending) | Shown on the owner's decision | Deliberately not shown |
|---|---|---|
| `nz_parliament_mp_directory` (RIGHTS-13) | Member name (display and sort form), party label, list or electorate, electorate name, link to the official profile page, the project's own observation basis and dates, relationship labels | Contact details and portraits (never collected), the publisher's profile slug |
| `nz_parliament_current_bills` (RIGHTS-09) | Bill title, number, type, current stage, select committee, Parliament number, member in charge and party label as listed, link to the official bill page | Bill text and attachments (never collected), the publisher's internal id |
| `nz_government_releases_feed` (RIGHTS-08) | Release title, link to the official release | Feed summary and release text (never collected), feed item id |
| `baseline_2023_candidacies_export` (RIGHTS-01) | Candidate name, party label, electorate name and type, candidacy type and status, source class of the status, link | **Vote figures, shares and list positions**; upstream surrogate ids |

Signals that stay on record and are **not** resolved by the owner decision (a person should weigh them): the members directory host's robots.txt disallows automated clients; the bills endpoint is undocumented; no terms URL could be retrieved for the releases publisher; no person's terms review exists for any source. See [pr8-review-disposition.md](pr8-review-disposition.md).

**Never releasable by an owner decision**, enforced twice (the validator `tools/owner_authorization.ts` and a table constraint, held equal by a test): any field name containing email, phone, address, contact, social handles, body, content, html, text, passage, description, summary, excerpt, transcript, portrait, image, photo, donor, birth, gender, ethnic, vote, share, rank, seats, score, confidence, value, pct, percent, total, amount, sample, payload, or a publisher identifier. The list is a floor for names in use today, not a proof about names added later: a new figure column needs a new look at this list. One such name makes the **whole file** invalid, which authorizes nothing.

**Identities stay source-specific.** Canonical (merged) people and parties remain withheld in full; the same name in two sources is two identities. Nothing in this release links them.

### Field decisions still open (blockers for a fuller site, reported rather than worked around)

1. **2023 vote figures and list positions.** Excluded. They need their own recorded decision and an R1 look at presentation; the forbidden-name rule means that is a deliberate code change, not a file edit.
2. **Publisher permission for any field.** None exists. If a publisher refuses or restricts, set the rights row accordingly: that source disappears at once and the owner decision cannot bring it back.
3. **Everything descended from the 20 products with no route** (results, finance, committee business, questions, statistics, polls, policy pages). Nothing to decide until a route exists.

## 3. Coverage of this first release

| | Count | Detail |
|---|---|---|
| Catalogue products | 24 | |
| Through a live adapter | **3** | P10 members (122 rows), P03 current bills (93), P01 releases **feed window only** (10). Counts are from the 2026-09-20 rehearsal and will differ on the day. |
| Through the verified historical export | **1** | P04: 963 candidacies of the 2023 election (495 electorate, 468 party-list), checksum-pinned. A 2023 baseline, not 2026. |
| **Not in the store** | **20** | Listed by name on the explorer's overview page, above the scope cards, open by default. |

The overview states "20 of the 24 catalogue products are not in this store" before anything else. The list is held equal to `catalogue/sources.json` and the source configuration by `tools/release_coverage.test.ts`. The four Electoral Commission live sources remain blocked by a challenge page and are not worked around.

## 4. What was verified, and where

All on a **separate local disposable stack** (its own project id and ports, so the shared local stack was neither reset nor touched): migrations from scratch; pgTAP 11 files / 368 assertions, on an empty database and again on one holding real data, fixtures and the owner decision; ingestion and tooling unit tests 98 pass / 3 skipped; integration 16/16 with skipping forbidden; explorer unit tests 41; browser tests 26 + 4 Pages routing, including the override path (gates closed, decision recorded → notice, named fields of one source only, refused source invisible, revoke → everything withheld); generated types match; Python validators and compliance tests; copy red-line scan. A full rehearsal ran the three live adapters and the export import, mirrored the real owner file with the real script, and read the result as an anonymous client: names, parties, seats, titles and links present; vote figures, list positions and publisher ids null; no gate open; no rights row changed.

The connected-bundle check was run on real builds: public URL + anon key passes; a service-role key, a key from another project, and an unconnected build each fail.

Found on the way and fixed in the same migration: the 2023 projection reused one result set per election across sources, so a **second** candidacy source would have inherited the first one's lineage and release tier. Only one such source exists, so nothing was exposed; the lookup is now per source, and the projection tests pass with two.

An independent automated adversarial read of the first commit (not a human review, not a sign-off) reported one high and several lower findings. All were checked against the code; those confirmed are fixed with tests: the worker could undo a publisher restriction (above); a review row with a stray pipe was skipped by the register parser, which would have let the override open past a REJECTED row (the override path now refuses any register line it cannot read as a row); figure columns other than votes were not in the forbidden list; the sync treated a missing status as active, ignored an edited entry and left a deleted entry running; the notice vanished once both gates opened while owner-shown fields remained; dates followed the session time zone. **Known and not fixed:** `candidacies.electorate_name` is read from the electorate version, which the first source to name that electorate evidenced; with a second candidacy source the name could be shown under the second source's field decision. One candidacy source exists, the text is the same electorate name, and canonical merging is not involved; it needs a per-source electorate label before a second source is added.

## 5. Hosted steps for the coordinator (none has been run)

Pre-condition: the independent readiness review of this branch. Credentials come from the operator's shell, a password file or a hidden prompt; **no value appears below and none belongs on a command line**. `<ref>` is the hosted project reference.

```bash
# 0. Administrator connection for psql: PGHOST / PGPORT / PGDATABASE / PGUSER + PGPASSFILE (runbook step 0)

# 1. Pre-flight, read-only. Keep the output; stop on any unexpected evidence_* object.
psql -v ON_ERROR_STOP=1 -f scripts/db/inspect_existing_objects.sql

# 2. Migrations (14 files; the last is 20260920001400_owner_authorization.sql)
supabase link --project-ref <ref>
supabase db push --dry-run        # read it
supabase db push
psql -v ON_ERROR_STOP=1 -f scripts/db/inspect_existing_objects.sql   # compare with step 1

# 3. Dashboard: expose ONLY evidence_public, evidence_open, evidence_inspector. Sign-ups off. Site URL = the Pages URL.

# 4. Worker login (hidden prompt; a SCRAM verifier is sent, never the password)
node ingest/src/operator.ts set-ingest-login

# 5. Registry, then the imports, as the WORKER. EVIDENCE_INGEST_DB_URL is set in the operator's shell, never typed here.
cd ingest && npm ci
node src/cli.ts validate
node src/cli.ts registry-sync
node src/access_check.ts --record --receipt access.json
node src/cli.ts run nz_parliament_mp_directory  --receipt receipt-mp.json
node src/cli.ts run nz_parliament_current_bills --receipt receipt-bills.json
node src/cli.ts run nz_government_releases_feed --receipt receipt-releases.json
export EVIDENCE_EXPORT_BASELINE_2023_CANDIDACIES=<verified candidacies JSON Lines file, outside the repository>
export EVIDENCE_EXPORT_BASELINE_2023_MANIFEST=<that capture's manifest.json>
node src/cli.ts import baseline_2023_candidacies_export --dry-run
node src/cli.ts import baseline_2023_candidacies_export --backfill --receipt receipt-baseline.json   # expect 963; read input_findings
cd ..

# 6. With NOTHING authorized yet, prove the closed state from outside (public anon key only):
#    GET /rest/v1/records            -> []          GET /rest/v1/surface_status -> release_basis "none"
#    GET /rest/v1/dataset_catalogue  -> rows        POST/PATCH/DELETE           -> refused      (runbook step 7)

# 7. Mirror the owner's decision, as ADMINISTRATOR, from the repository root
node tools/owner_authorization.ts                                   # must print "valid" and the six scopes
psql -v ON_ERROR_STOP=1 -f scripts/db/sync_owner_authorizations.sql
#    Readback must show: every gate "closed", public_rows_released t, release_basis owner_override,
#    rights_rows_not_pending 0, owner_fields 22 / 13 / 3 / 22 on the four sources and 0 everywhere else.

# 8. From outside again: names, parties, seats, titles and links present for the four sources; votes, list_rank,
#    external_id null; evidence_private / evidence_views / auth / vault unreachable; writes refused.

# 9. Repository variables: PUBLIC values only. Never the service-role key, a database password or an access token.
gh variable set EXPLORER_SUPABASE_URL      --body "https://<ref>.supabase.co"
gh variable set EXPLORER_SUPABASE_ANON_KEY            # paste the PUBLIC anon (or publishable) key at the prompt
gh variable set PAGES_DEPLOY_ENABLED       --body "true"

# 10. Merge to main. The workflow runs every check, the freeze check, the gate (owner override, logged as such),
#     the connected-bundle check, then deploys. Open the site: the owner notice must be on every page.
```

Scheduled ingestion (function deploy, Vault, one-at-a-time activation) is **not** part of this first release; it stays as written in [runbook.md](runbook.md) steps 5 and 8–10. Until then data is as fresh as the last manual run, and the Sources page says when that was.

**Withdraw:** set `"status": "revoked"` with `revoked_on` and `revoked_reason` in the owner file, commit, re-run step 7's script: rows and fields vanish at once. `gh variable set PAGES_DEPLOY_ENABLED --body "false"` stops further deployments. Removing the published site itself is a repository Pages setting.

## 6. Choices made in this lane that the owner should confirm

- **Expiry 2026-11-06.** The instruction gave no end date; a narrow override should lapse, and the day before election day was chosen so that continuing through the freeze takes a fresh, deliberate decision. On 7 November the site would show the "release pending" page unless the reviews are recorded or a new decision is made before then. Change `expires_on` (at most 90 days) before step 7 if this is not what is wanted; after it is mirrored, a decision is never edited, only superseded.
- **The decision names the owner** in the repository file; the database withholds the name per row, like every other individual's name (R7 convention).
- **`request_source`** says the request came over Telegram and was relayed; the message is not in the repository. If it should be quoted or referenced more exactly, only the owner can supply that.

## 7. Coordinator readiness notes received during this work, each checked rather than assumed

| Note | Checked how | Result |
|---|---|---|
| Map `baseline_2023_candidacies_export` to RIGHTS-03 (the row listing P04) instead of RIGHTS-01 | Read the register and the verified export itself | **Not changed, with reasons.** All 963 rows cite `electionresults.govt.nz/electionresults_2023/`, which is RIGHTS-01's publisher page. RIGHTS-03 is the `elections.nz` historical pages behind the *older 486-row roster* that this export is preferred over. A rights row follows where the rows came from, not the catalogue product the source is reconciled against. Both rows are the same publisher and both are pending, so nothing is released or hidden differently either way; if the owner wants both rows to govern, that is a register decision (restricting either should then hide the source) and needs a schema change, not a relabel. |
| The worker must not be able to approve fields for itself | Read the policies and tests | **Already enforced and tested.** Row-level policies let the worker insert or update a rights row only as `pending`, undated, with no `approved_fields` (`030`: `approve_rights` denied). The owner path adds no worker route: the worker can neither write the owner tables nor run the sync (`100`). |
| Graph endpoints under the field projection; no canonical identity invented | Rehearsal, read as an anonymous client | 193 edges (members) and 1,842 (2023 candidacies) with ids and labels present; **0** edges to or from a canonical person or party. Navigation is source identity → party label / electorate, per source. |
| Hosted prerequisites | Read the migrations | `pg_cron` and `pg_net` are created by migration `…000900` (they must be available on the project); Vault is needed only for scheduled ingestion, which is outside this first release. Expose `evidence_public`, `evidence_open`, `evidence_inspector` only. Apply the 14 migrations once, in order, through `supabase db push`; never replay a part by hand. |
