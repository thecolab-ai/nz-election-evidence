-- Default deny is structural: every object is withheld or has recorded lineage; every exposed column is
-- withheld or classified; nothing withheld is exposed; no projection lacks the release join.
begin;
select plan(10);

select is((select string_agg(n.nspname || '.' || c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where ((n.nspname = 'evidence_private' and c.relkind = 'r') or (n.nspname = 'evidence_views' and c.relkind = 'v'))
              and not exists (select 1 from evidence_private.public_lineage l where l.object_schema = n.nspname and l.object_name = c.relname)
              and not exists (select 1 from evidence_private.public_withheld w where w.object_schema = n.nspname and w.object_name = c.relname and w.column_name = '*')),
  null, 'every table and base view either records its source lineage or is withheld with a reason');
select is((select string_agg(n.nspname || '.' || c.relname || '.' || a.attname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
            join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
            join evidence_private.public_lineage l on l.object_schema = n.nspname and l.object_name = c.relname
            where not exists (select 1 from evidence_private.public_columns pc where pc.object_schema = n.nspname and pc.object_name = c.relname and pc.column_name = a.attname)
              and not exists (select 1 from evidence_private.public_withheld w where w.object_schema = n.nspname and w.object_name = c.relname and w.column_name in (a.attname, '*'))),
  null, 'drift check: every column of an exposed object is classified or withheld (run classify_public_columns and rebuild_exposed_views after schema changes)');
select is((select string_agg(o.nspname || '.' || oc.relname || '.' || oa.attname, ', ')
            from pg_class oc join pg_namespace o on o.oid = oc.relnamespace
            join pg_attribute oa on oa.attrelid = oc.oid and oa.attnum > 0
            where o.nspname in ('evidence_open', 'evidence_public') and oc.relname not in ('surface_status', 'dataset_columns', 'dataset_catalogue')
              and not exists (select 1 from evidence_private.public_columns pc
                              where pc.object_schema = case o.nspname when 'evidence_open' then 'evidence_private' else 'evidence_views' end
                                and pc.object_name = oc.relname and pc.column_name = oa.attname)),
  null, 'no projected column exists without a release class');
select is((select string_agg(oc.relname || '.' || w.column_name, ', ') from evidence_private.public_withheld w
            join pg_class oc on oc.relname = w.object_name join pg_namespace o on o.oid = oc.relnamespace
              and o.nspname = case w.object_schema when 'evidence_private' then 'evidence_open' else 'evidence_public' end
            left join pg_attribute oa on oa.attrelid = oc.oid and oa.attname = w.column_name and oa.attnum > 0
            where w.column_name = '*' or oa.attname is not null),
  null, 'nothing on the withheld register is projected');
select is((select string_agg(o.nspname || '.' || oc.relname, ', ') from pg_class oc join pg_namespace o on o.oid = oc.relnamespace
            join evidence_private.public_lineage l on l.object_name = oc.relname
              and l.object_schema = case o.nspname when 'evidence_open' then 'evidence_private' else 'evidence_views' end
            where o.nspname in ('evidence_open', 'evidence_public') and l.lineage_kind = 'source'
              and (pg_get_viewdef(oc.oid) not like '%source_release%' or pg_get_viewdef(oc.oid) not like '%rel.tier <> ''none''%')),
  null, 'every source-lineage projection joins the release tier and excludes tier none');
select is((select string_agg(o.nspname || '.' || oc.relname, ', ') from pg_class oc join pg_namespace o on o.oid = oc.relnamespace
            where o.nspname in ('evidence_open', 'evidence_public') and oc.relkind = 'v'
              and oc.relname not in ('surface_status', 'dataset_columns', 'dataset_catalogue')
              and pg_get_viewdef(oc.oid) not like '%release_gates%'),
  null, 'every projection checks the release gates');
select is((select count(*)::int from evidence_private.public_columns pc join evidence_private.public_lineage l
             on l.object_schema = pc.object_schema and l.object_name = pc.object_name
            where l.lineage_kind = 'source' and pc.release_class = 'link'
              and pc.column_name in ('safe_payload', 'title', 'label', 'name_at_source', 'name_display', 'display_name', 'member_name', 'candidate_name',
                                     'party_label', 'votes', 'value', 'summary_text', 'external_id', 'external_record_id', 'source_date_text')
              and pc.object_name not in ('sources')), 0,
  'no payload, name, title, vote, value or publisher identifier is classed as link metadata');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('evidence_public', 'evidence_open', 'evidence_inspector')), 0, 'still no function in any exposed schema');

select is((select string_agg(o.nspname || '.' || oc.relname || '.' || oa.attname, ', ')
            from pg_class oc join pg_namespace o on o.oid = oc.relnamespace
            join pg_attribute oa on oa.attrelid = oc.oid and oa.attnum > 0
            where o.nspname in ('evidence_open', 'evidence_public') and oc.relkind = 'v'
              and oa.attname in ('person_id', 'party_id', 'target_person_id', 'target_party_id', 'linked_person_name', 'linked_party_name',
                                 'display_name', 'canonical_name', 'created_via_decision_id')),
  null, 'canonical people and parties: no projection carries a canonical id or name (consistent withholding)');
select is((select count(*)::int from pg_class oc join pg_namespace o on o.oid = oc.relnamespace
            where o.nspname in ('evidence_open', 'evidence_public') and oc.relname in ('people', 'parties', 'party_aliases')), 0,
  'canonical tables and their aliases have no projection');

select * from finish();
rollback;
