-- Mirrors governance/owner-authorizations.json into the database, as ADMINISTRATOR, from the repository root.
-- The file is the source of truth and is validated first by `node tools/owner_authorization.ts` (run that and
-- read its output before this). This records the OWNER'S decision. It opens no release gate, approves no rights
-- row and records no review: release_gates, source_rights and every review table are left exactly as they are,
-- and the readback below shows that.
--
--   node tools/owner_authorization.ts
--   psql -v ON_ERROR_STOP=1 -f scripts/db/sync_owner_authorizations.sql        (connection from PG* variables, see runbook step 0)
--
-- Revoke: set "status": "revoked" with revoked_on and revoked_reason in the file, commit, run this again.
-- Every row and field shown on the owner's decision is withheld again at once; no deployment is needed.

\set content `cat governance/owner-authorizations.json`
\set file_hash `sha256sum governance/owner-authorizations.json | cut -d' ' -f1`

select evidence_private.sync_owner_authorizations(:'content'::jsonb, 'sha256:' || :'file_hash') as sync_result;

-- Readback. Gates stay as they were; the basis says why rows are (or are not) released.
select gate_key, state, public_rows_released, release_basis, owner_authorization_id, owner_expires_on
  from evidence_public.surface_status order by gate_key;
select source_id, rights_review_status, public_release_tier, cardinality(owner_authorized_fields) as owner_fields
  from evidence_views.sources order by source_id;
select count(*) filter (where review_status <> 'pending') as rights_rows_not_pending from evidence_private.source_rights;
