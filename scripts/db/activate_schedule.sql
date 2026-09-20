-- Activates ONE schedule, and only with proof that the deployed function answered an authenticated
-- readback call (docs/database/runbook.md, "Activating a schedule"). The database refuses otherwise.
--
--   psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 -v schedule_key=releases-feed-hourly \
--        -v readback_run_id=<run_id returned by the readback call> \
--        -v function_version="ingest-run/1.0.0" -v activated_by="Full Name" -f scripts/db/activate_schedule.sql
--
-- Deactivate:  add  -v deactivate=1

\if :{?deactivate}
select evidence_private.deactivate_schedule(:'schedule_key');
\else
select evidence_private.activate_schedule(:'schedule_key', :'readback_run_id'::uuid, :'function_version', :'activated_by') as cron_jobid;
\endif

-- Readback: desired state next to what pg_cron really holds.
select s.schedule_key, s.state, s.cron_jobid, s.activated_by, s.activated_at, j.schedule as cron_schedule, j.active as cron_active
from evidence_private.ingest_schedules s left join cron.job j on j.jobname = s.schedule_key
order by s.schedule_key;
