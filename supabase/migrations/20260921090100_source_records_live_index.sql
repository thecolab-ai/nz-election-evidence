-- Counting one source's live records read the table instead of an index.
--
-- evidence_views.sources (last defined in 20260921040100_unified_import.sql) computes live_records
-- as a correlated scalar subquery:
--
--   select count(*) from evidence_private.source_records r
--    where r.source_id = s.source_id and r.tombstoned_at is null
--
-- The two indexes that table already carries are source_records_kind (source_id, record_kind) and
-- the unique constraint (source_id, external_record_id). Neither carries tombstoned_at, so the
-- count could not be answered from an index: it walked every index entry for the source and then
-- visited the heap row by row to read tombstoned_at.
--
-- That cost is not spread evenly across sources. One export dominates the store - the written
-- questions source holds 187,956 of 203,536 live records, 92% of everything, while every other
-- source is in the thousands. So a single row of the view costs more than all the others together.
--
-- Measured against the deployed anonymous endpoint on 2026-09-21: the per-source live_records count
-- answers in about 0.14 s with the heap already in shared buffers, and 2.4-3.7 s cold. The anonymous
-- statement budget is about 3 s. Straddling the budget is why /overview and /sources answered 57014
-- (canceling statement due to statement timeout) intermittently rather than always.
--
-- This index carries only the live rows, and only the column the count filters on, so the count is
-- answered from a narrow index rather than by reading the table. It is additive: no view, column,
-- row, grant, policy or API surface changes, and there is nothing to backfill. If the planner ever
-- prefers a different path the query is no worse than it is today, because nothing else is altered.
--
-- Plain create index, not concurrently: the table is about 203k rows so the build is sub-second, it
-- blocks importer writes only and never readers, and create index concurrently cannot run inside the
-- transaction a migration is applied in.

create index if not exists source_records_live
  on evidence_private.source_records (source_id)
  where tombstoned_at is null;

comment on index evidence_private.source_records_live is
  'Live (not tombstoned) records only, keyed by source. Lets evidence_views.sources.live_records be counted from an index instead of a heap walk. Carries no content: source_id is an identifier this project assigns.';

-- So the planner costs the new index against current statistics rather than stale ones.
analyze evidence_private.source_records;
