-- What an ANONYMOUS reader actually receives. Read-only; writes nothing but a temporary table.
--
--   psql -v ON_ERROR_STOP=1 -f scripts/db/public_value_audit.sql            (connection from PG* variables, runbook step 0)
--   psql -v ON_ERROR_STOP=1 -v sample=5000 -f scripts/db/public_value_audit.sql
--
-- Every measurement below is taken with `set role anon`, so it is the anonymous view and nothing else: an
-- administrator's own privileges are never used to read a value that is then reported as public. The point of
-- the script is that "the dataset is published" and "the dataset carries values" are different claims. A
-- projection whose content columns are all null is reported as EMPTY_CONTENT, not as published.
--
-- Part A  every dataset of evidence_public and evidence_open, column by column: rows an anonymous reader sees
--         and how many of them carry a value, with the register's disposition for that column.
-- Part B  every catalogue product, source by source: release tier, how many field names a current owner
--         decision shows, and what the anonymous sources view reports the source holds.
-- Part C  the gaps, stated as gaps: content columns that are published and empty, and datasets with no rows.
-- Part D  the allowlisted payload, KEY BY KEY, per source. `safe_payload` is one column whose keys are gated
--         individually, so "that column has a value" says nothing about which keys a reader receives. Part A
--         cannot see this; Part D is the only place a dropped payload key shows up.
--
-- `sample` bounds the per-column pass (default 20000 rows); the row count itself is always exact. A dataset
-- smaller than the sample is measured exactly and reads `exact`. A larger one is measured over an ARBITRARY,
-- unordered window of that size, reads `sampled window`, and a column reported empty there is empty IN THE
-- SAMPLE and nothing more: one dataset of a million rows can hold rows of eight sources, and the window may
-- land entirely inside one of them. Never quote a `sampled window` row as a gap without checking that column
-- for the source you mean. Raise `sample` to measure a big dataset exactly (it is slow: the projections join
-- a release tier per row).

\set ON_ERROR_STOP on
\if :{?sample}
\else
\set sample 20000
\endif

set public_value_audit.sample = :sample;

create temporary table if not exists public_value_audit (
  exposed_schema text, dataset text, column_name text, disposition text, field_token text,
  visible_rows bigint, sampled bigint, with_value bigint
);
truncate public_value_audit;

do $audit$
declare
  v_rel record;
  v_cols text;
  v_rows bigint;
  v_sampled bigint;
  v_values jsonb;
  v_sample integer := current_setting('public_value_audit.sample')::integer;
begin
  for v_rel in
    select n.nspname as nsp, c.relname as rel, c.oid
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('evidence_public', 'evidence_open') and c.relkind = 'v'
    order by n.nspname, c.relname
  loop
    select string_agg(format('%L, count(%I)', a.attname, a.attname), ', ' order by a.attnum) into v_cols
    from pg_attribute a where a.attrelid = v_rel.oid and a.attnum > 0 and not a.attisdropped;
    if v_cols is null then continue; end if;

    begin
      execute 'set role anon';
      execute format('select count(*) from %I.%I', v_rel.nsp, v_rel.rel) into v_rows;
      execute format(
        'select count(*), jsonb_build_object(%s) from (select * from %I.%I limit %s) t',
        v_cols, v_rel.nsp, v_rel.rel, v_sample) into v_sampled, v_values;
      execute 'reset role';
    exception when others then
      execute 'reset role';
      raise;
    end;

    insert into public_value_audit (exposed_schema, dataset, column_name, disposition, field_token, visible_rows, sampled, with_value)
    select v_rel.nsp, v_rel.rel, a.attname,
           coalesce(dc.disposition, 'not_in_register'), dc.field_token,
           v_rows, v_sampled, (v_values ->> a.attname)::bigint
    from pg_attribute a
    left join evidence_public.dataset_columns dc
      on dc.exposed_schema = v_rel.nsp and dc.dataset = v_rel.rel and dc.column_name = a.attname
    where a.attrelid = v_rel.oid and a.attnum > 0 and not a.attisdropped;
  end loop;
end
$audit$;

-- Part A ---------------------------------------------------------------------------------------------------
\echo '== Part A: datasets an anonymous reader can read, and whether their columns carry values =='
select exposed_schema, dataset, max(visible_rows) as visible_rows, max(sampled) as sampled,
       count(*) filter (where disposition = 'rights_gated_content') as content_columns,
       count(*) filter (where disposition = 'rights_gated_content' and with_value > 0) as content_columns_with_values,
       count(*) filter (where disposition in ('public', 'link_metadata')) as open_columns,
       count(*) filter (where disposition in ('public', 'link_metadata') and with_value > 0) as open_columns_with_values
from public_value_audit
group by 1, 2 order by 1, 2;

\echo '== Part A2: every content column, and whether an anonymous reader receives a value =='
select exposed_schema, dataset, column_name, field_token, visible_rows, sampled, with_value
from public_value_audit
where disposition = 'rights_gated_content'
order by (with_value > 0), exposed_schema, dataset, column_name;

-- Part B ---------------------------------------------------------------------------------------------------
\echo '== Part B: catalogue products, source by source, as the anonymous reader sees them =='
set role anon;
select coalesce(m.product_id, '(no product)') as product_id, s.source_id, s.publisher,
       s.rights_review_status, s.public_release_tier,
       cardinality(s.owner_authorized_fields) as owner_fields,
       s.live_records, s.statistical_observations, s.statistical_observations_without_a_number,
       s.freshness_status
from evidence_public.sources s
left join evidence_open.catalogue_product_map m on m.source_id = s.source_id
order by 1, 2;
reset role;

-- Part C ---------------------------------------------------------------------------------------------------
\echo '== Part C: published but EMPTY. An `exact` row is a gap; a `sampled window` row is a gap only in the window =='
select exposed_schema, dataset, column_name, field_token, visible_rows,
       case when sampled >= visible_rows then 'exact' else 'sampled window' end as measured
from public_value_audit
where disposition = 'rights_gated_content' and visible_rows > 0 and with_value = 0
order by (sampled >= visible_rows) desc, 1, 2, 3;

\echo '== Part C2: datasets an anonymous reader can reach that return no row at all =='
select exposed_schema, dataset from public_value_audit
group by 1, 2 having max(visible_rows) = 0 order by 1, 2;

\echo '== Part C3: totals =='
select count(distinct (exposed_schema, dataset)) as datasets,
       count(distinct (exposed_schema, dataset)) filter (where visible_rows > 0) as datasets_with_rows,
       count(*) filter (where disposition = 'rights_gated_content') as content_columns,
       count(*) filter (where disposition = 'rights_gated_content' and with_value > 0) as content_columns_with_values
from public_value_audit;

-- Part D ---------------------------------------------------------------------------------------------------
-- Both passes read at most `sample_versions` record versions per source, so this is a per-source sample and a
-- key seen in neither pass may simply not be in that sample. A key in `held_not_shown` IS a real gap: it was
-- read from the publisher, it is stored, and an anonymous reader does not receive it.
\if :{?sample_versions}
\else
\set sample_versions 300
\endif
set public_value_audit.sample_versions = :sample_versions;

create temporary table if not exists public_payload_audit (source_id text, key text, held bigint, shown bigint);
truncate public_payload_audit;
grant insert on public_payload_audit to anon;

-- Held: read as administrator, straight from the private ledger.
insert into public_payload_audit (source_id, key, held, shown)
select src.source_id, e.key, count(*), 0
from evidence_private.sources src
cross join lateral (
  select v.safe_payload
  from evidence_private.source_records rr
  join evidence_private.source_record_versions v on v.record_id = rr.id
  where rr.source_id = src.source_id
  limit current_setting('public_value_audit.sample_versions')::integer) v
cross join lateral jsonb_each(v.safe_payload) e
group by 1, 2;

-- Shown: read AS ANON, through the same projection a reader uses. Driven from the curated record_versions view,
-- which carries source_id itself: joining the two open table projections instead costs minutes on a loaded store,
-- because a barrier view will not push the source filter through the join.
set local role anon;
insert into public_payload_audit (source_id, key, held, shown)
select src.source_id, e.key, 0, count(*)
from evidence_public.sources src
cross join lateral (
  select v.safe_payload from evidence_public.record_versions v
  where v.source_id = src.source_id
  limit current_setting('public_value_audit.sample_versions')::integer) v
cross join lateral jsonb_each(v.safe_payload) e
group by 1, 2;
reset role;

\echo '== Part D: payload keys HELD by a source but NOT shown to an anonymous reader =='
select p.source_id, p.key, sum(p.held) as held,
       case when p.key = any (max(r.owner_fields::text)::text[]) then 'an owner scope names this key, and it is still not shown'
            else 'no owner scope and no publisher approval names this key' end as why
from public_payload_audit p
join evidence_private.source_release r on r.source_id = p.source_id
group by p.source_id, p.key
having sum(p.held) > 0 and sum(p.shown) = 0
order by 1, 2;

\echo '== Part D2: payload keys an anonymous reader does receive, per source =='
select source_id,
       count(*) filter (where shown > 0) as keys_shown,
       count(*) filter (where held > 0) as keys_held,
       string_agg(key, ', ' order by key) filter (where shown > 0) as shown
from (select source_id, key, sum(held) as held, sum(shown) as shown from public_payload_audit group by 1, 2) k
group by 1 order by 1;
