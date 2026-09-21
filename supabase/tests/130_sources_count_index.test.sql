-- The index that lets evidence_views.sources.live_records be counted without reading the table.
--
-- What this file can and cannot prove. It runs on a disposable database holding fixtures, not on the
-- deployed store's 203,536 records, so a wall-clock assertion here would prove nothing about the
-- timeouts this index was added for and none is made. What IS checkable here, and is checked:
--
--   1. The index exists, is valid, and is exactly the shape the count needs - one column, btree,
--      restricted to live rows. A wider or differently-predicated index would not be index-only for
--      this count, so the shape is the substance, not decoration.
--   2. The planner actually reaches for it when counting one source's live records, and stops
--      reading the whole table to do it.
--   3. The index changes the path and not the answer: the same count comes back when the planner is
--      forbidden every index, and the view still reports live and tombstoned records correctly.
--   4. The index the table already had is still there - this migration adds, it does not replace.
--
-- The honest end-to-end proof that this worked is the live lane's sources test passing against the
-- deployment without a retry, which no disposable database can stand in for.
--
-- TEST FIXTURES ONLY: synthetic, rolled back. RIGHTS-78x are distinct from every other fixture's.
begin;
select plan(9);

create function pg_temp.src(p_id text) returns jsonb language sql as $$
  select jsonb_build_object('source_id', p_id, 'title', 'Fixture ' || p_id, 'publisher', 'Fixture Publisher',
    'official_url', 'https://fixture.example/' || p_id, 'adapter_kind', 'export_import', 'adapter_name', 'fixture',
    'allowed_hosts', jsonb_build_array(), 'rights_id', 'RIGHTS-781', 'view_scope', 'general',
    'snapshot_semantics', 'complete_snapshot', 'enabled', false, 'config_hash', 'f');
$$;

select evidence_private.sync_registry(jsonb_build_object(
  'rights', jsonb_build_array(jsonb_build_object('rights_id', 'RIGHTS-781', 'publisher', 'Fixture Publisher',
    'source_url', 'https://fixture.example/', 'review_status', 'pending', 'default_release', 'link-only', 'register_hash', 'h')),
  'sources', jsonb_build_array(pg_temp.src('pgtap_idx_target'), pg_temp.src('pgtap_idx_bulk'))));

-- The target source is a minority of the table, which is the case a per-source count is actually
-- asked in: the reader opens one source, not the whole store.
insert into evidence_private.source_records (source_id, external_record_id, record_kind, first_seen_at, last_seen_at)
select 'pgtap_idx_target', 'live-' || n, 'fixture_record', now(), now() from generate_series(1, 2000) n;
insert into evidence_private.source_records (source_id, external_record_id, record_kind, first_seen_at, last_seen_at, tombstoned_at, tombstone_reason)
select 'pgtap_idx_target', 'gone-' || n, 'fixture_record', now(), now(), now(), 'absent from a complete snapshot' from generate_series(1, 50) n;
insert into evidence_private.source_records (source_id, external_record_id, record_kind, first_seen_at, last_seen_at)
select 'pgtap_idx_bulk', 'live-' || n, 'fixture_record', now(), now() from generate_series(1, 18000) n;

analyze evidence_private.source_records;

-- 1-3. The index is the shape the count needs -----------------------------------------------------------------

select is((select count(*)::int from pg_class c
            join pg_namespace ns on ns.oid = c.relnamespace
            join pg_index i on i.indexrelid = c.oid
           where ns.nspname = 'evidence_private' and c.relname = 'source_records_live'
             and c.relkind = 'i' and i.indisvalid and not i.indisunique), 1,
  'the partial index exists on evidence_private.source_records, is valid, and constrains nothing');

select is((select pg_get_expr(i.indpred, i.indrelid) from pg_index i
            join pg_class c on c.oid = i.indexrelid
            join pg_namespace ns on ns.oid = c.relnamespace
           where ns.nspname = 'evidence_private' and c.relname = 'source_records_live'),
  '(tombstoned_at IS NULL)',
  'it holds live rows only - which is what removes the heap visit that read tombstoned_at per row');

select ok((select pg_get_indexdef(c.oid) from pg_class c
             join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = 'evidence_private' and c.relname = 'source_records_live')
          like '%USING btree (source_id)%',
  'and it is keyed on source_id alone, so the count can be answered from the index without widening it');

-- 4. Nothing was replaced -------------------------------------------------------------------------------------

select is((select count(*)::int from pg_class c
            join pg_namespace ns on ns.oid = c.relnamespace
           where ns.nspname = 'evidence_private' and c.relname = 'source_records_kind' and c.relkind = 'i'), 1,
  'the index the table already had is untouched: this migration adds a path, it does not take one away');

-- 5-6. The planner uses it for the live_records subquery -------------------------------------------------------

create function pg_temp.plan_of(p_sql text) returns text language plpgsql as $$
declare line text; acc text := '';
begin
  for line in execute 'explain (costs off) ' || p_sql loop acc := acc || line || E'\n'; end loop;
  return acc;
end $$;

-- Character for character the live_records subquery of evidence_views.sources, with the correlated
-- source_id bound to one source.
create function pg_temp.live_count_plan() returns text language sql as $$
  select pg_temp.plan_of($q$select count(*) from evidence_private.source_records r
    where r.source_id = 'pgtap_idx_target' and r.tombstoned_at is null$q$);
$$;

select ok(pg_temp.live_count_plan() like '%source_records_live%',
  'counting one source''s live records reaches for the new index');

select ok(pg_temp.live_count_plan() not like '%Seq Scan on source_records%',
  'and no longer reads the whole table to answer it');

-- 7-8. The view still reports the truth ------------------------------------------------------------------------

select is((select live_records from evidence_views.sources where source_id = 'pgtap_idx_target'), 2000::bigint,
  'the view counts every live record of the source and no record of any other source');

select is((select tombstoned_records from evidence_views.sources where source_id = 'pgtap_idx_target'), 50::bigint,
  'and tombstoned records are still counted apart from live ones, not swept into the same number');

-- 9. The index changed the path, not the answer -----------------------------------------------------------------

set local enable_indexscan = off;
set local enable_indexonlyscan = off;
set local enable_bitmapscan = off;

select is((select count(*) from evidence_private.source_records r
            where r.source_id = 'pgtap_idx_target' and r.tombstoned_at is null), 2000::bigint,
  'and with every index path forbidden the table answers the same number, so the index is an optimisation and not a filter');

reset enable_indexscan;
reset enable_indexonlyscan;
reset enable_bitmapscan;

select * from finish();
rollback;
