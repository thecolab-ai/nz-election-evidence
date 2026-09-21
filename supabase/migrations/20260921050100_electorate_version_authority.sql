-- Which version established a shared electorate version, decided by the publishers and not by the load order.
--
-- An electorate version is a SHARED civic row: the 2023 candidacy roster and the 2023 electorate results both name the
-- same electorate, and whichever import ran first used to win the single evidence_version_id pointer
-- (insert ... on conflict do update leaves the original in place). The stored provenance therefore depended on the
-- order the coordinator happened to run the families in, which is not a property of what any publisher said.
--
-- Two changes, and neither of them throws provenance away:
--   1. every version that asserts an electorate version is recorded, in electorate_version_attestations. Nothing is
--      lost: the roster's assertion and the results' assertion are both kept, and both remain resolvable to their
--      source, their record and their content hash.
--   2. evidence_version_id - the one version the row cites, and the one the public projection resolves its lineage
--      through - is then chosen from those attestations by a rule made of PUBLISHER data only: the earliest date a
--      publisher states, then the publisher's own source id, then the publisher's own record id, then the content hash.
--      The same set of attestations gives the same answer whatever order they arrived in.
--
-- The attestations are captured by a BEFORE INSERT trigger, which sees the row a projection PROPOSES even when that
-- insert goes on to conflict with an existing row. No existing migration is edited (the base schema is already applied
-- to the hosted project), and no projection function needs to know about any of this.
--
-- Additive and safe on a store that already holds rows: existing electorate versions are attested with the version they
-- already cite, so a store with one source per row keeps exactly the pointer it has.

create table evidence_private.electorate_version_attestations (
  electorate_id uuid not null references evidence_private.electorates (id),
  boundary_edition_id uuid not null references evidence_private.boundary_editions (id),
  evidence_version_id uuid not null references evidence_private.source_record_versions (id),
  primary key (electorate_id, boundary_edition_id, evidence_version_id)
);

comment on table evidence_private.electorate_version_attestations is
  'Every source version that asserts an electorate version, kept whole. One of them is cited by electorate_versions.evidence_version_id, chosen by publisher data alone; the others stay here, so no source loses its lineage because another source was loaded first.';
comment on column evidence_private.electorate_version_attestations.electorate_id is
  'The electorate and boundary edition are the natural key of the row being asserted: an attestation does not depend on which surrogate id survived an insert that conflicted.';

alter table evidence_private.electorate_version_attestations enable row level security;
revoke all on evidence_private.electorate_version_attestations from public, anon, authenticated;
grant select, insert on evidence_private.electorate_version_attestations to evidence_ingest;
create policy electorate_version_attestations_ingest_select on evidence_private.electorate_version_attestations
  for select to evidence_ingest using (true);
create policy electorate_version_attestations_ingest_insert on evidence_private.electorate_version_attestations
  for insert to evidence_ingest with check (true);
grant select on evidence_private.electorate_version_attestations to evidence_inspector_reader;
create policy electorate_version_attestations_reader_select on evidence_private.electorate_version_attestations
  for select to evidence_inspector_reader using (true);

-- What a row already cites is an assertion too: a store that holds rows keeps its provenance and gains nothing else.
insert into evidence_private.electorate_version_attestations (electorate_id, boundary_edition_id, evidence_version_id)
select ev.electorate_id, ev.boundary_edition_id, ev.evidence_version_id
from evidence_private.electorate_versions ev
where ev.evidence_version_id is not null
on conflict do nothing;

-- The rule, in one place: of the versions that assert this electorate version, the one the publishers put first.
create or replace function evidence_private.authoritative_electorate_version(p_electorate_id uuid, p_boundary_edition_id uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  select a.evidence_version_id
  from evidence_private.electorate_version_attestations a
  join evidence_private.source_record_versions v on v.id = a.evidence_version_id
  join evidence_private.source_records r on r.id = v.record_id
  where a.electorate_id = p_electorate_id and a.boundary_edition_id = p_boundary_edition_id
  -- Publisher data only: no surrogate key, no collection time, nothing about how the load was driven.
  order by coalesce(v.source_published_at, 'infinity'::timestamptz), r.source_id, r.external_record_id, v.content_hash
  limit 1;
$$;

comment on function evidence_private.authoritative_electorate_version(uuid, uuid) is
  'The version an electorate version cites: the earliest date a publisher states, then the publisher''s source id, its record id and the content hash. Deterministic, so two loads of the same inputs agree however they were ordered.';

-- A projection proposing an electorate version asserts it, whether its insert creates the row or conflicts with one.
create or replace function evidence_private.record_electorate_version_attestation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.evidence_version_id is not null then
    insert into evidence_private.electorate_version_attestations (electorate_id, boundary_edition_id, evidence_version_id)
    values (new.electorate_id, new.boundary_edition_id, new.evidence_version_id)
    on conflict do nothing;
  end if;
  return new;
end
$$;

-- Once the set of attestations has grown, the row cites whichever of them the rule puts first. This runs as a DEFERRED
-- constraint trigger, so it happens when the statement that added the attestation has finished rather than inside it: a
-- projection's own `insert ... on conflict do update` may not touch the same row twice in one command, and every write
-- here is one autocommit statement, so "deferred" means "immediately after this write".
create or replace function evidence_private.promote_authoritative_electorate_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_authoritative uuid;
begin
  v_authoritative := evidence_private.authoritative_electorate_version(new.electorate_id, new.boundary_edition_id);
  update evidence_private.electorate_versions ev
     set evidence_version_id = v_authoritative
   where ev.electorate_id = new.electorate_id and ev.boundary_edition_id = new.boundary_edition_id
     and ev.evidence_version_id is distinct from v_authoritative;
  return null;
end
$$;

create trigger electorate_versions_attest before insert on evidence_private.electorate_versions
  for each row execute function evidence_private.record_electorate_version_attestation();

create constraint trigger electorate_version_attestations_promote
  after insert on evidence_private.electorate_version_attestations
  deferrable initially deferred
  for each row execute function evidence_private.promote_authoritative_electorate_version();

revoke execute on function evidence_private.record_electorate_version_attestation(),
  evidence_private.promote_authoritative_electorate_version() from public;
revoke execute on function evidence_private.authoritative_electorate_version(uuid, uuid) from public;
grant execute on function evidence_private.authoritative_electorate_version(uuid, uuid) to evidence_ingest;

-- A store that already holds electorate versions from more than one source is settled once, here, by the same rule.
update evidence_private.electorate_versions ev
   set evidence_version_id = evidence_private.authoritative_electorate_version(ev.electorate_id, ev.boundary_edition_id)
 where ev.evidence_version_id is distinct from evidence_private.authoritative_electorate_version(ev.electorate_id, ev.boundary_edition_id);

-- Default-deny like every other table: the attestation resolves to a source through the version it names.
insert into evidence_private.public_lineage (object_schema, object_name, lineage_kind, lineage_sql, note) values
  ('evidence_private', 'electorate_version_attestations', 'source',
   '(select l.source_id from evidence_private.lineage_version l where l.version_id = b.evidence_version_id)',
   'Every row resolves to exactly one source through foreign keys; rows that do not are not shown.');

select evidence_private.classify_public_columns();
select evidence_private.rebuild_exposed_views();
