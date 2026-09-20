-- Aggregate statistical observations. Identity covers dataset, release vintage,
-- series, period and geography edition. Suppressed or missing never becomes zero.

create table evidence_private.stat_datasets (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references evidence_private.sources (source_id),
  dataset_key text not null,
  title text not null,
  publisher text not null,
  unique (source_id, dataset_key)
);

create table evidence_private.stat_releases (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references evidence_private.stat_datasets (id),
  release_key text not null,
  released_on date,
  source_snapshot_id text,
  unique (dataset_id, release_key)
);

comment on column evidence_private.stat_releases.release_key is
  'Release vintage. Overlapping releases stay separate; they are never summed or silently merged.';

create table evidence_private.stat_series (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references evidence_private.stat_datasets (id),
  series_key text not null,
  title text,
  unit text,
  magnitude text,
  seasonal_adjustment text,
  dimensions jsonb not null default '{}'::jsonb,
  unique (dataset_id, series_key)
);

create table evidence_private.geography_versions (
  id uuid primary key default gen_random_uuid(),
  scheme text not null,
  edition text not null,
  code text not null,
  name text,
  unique (scheme, edition, code)
);

comment on table evidence_private.geography_versions is
  'Statistical geographies by scheme and edition. Not interchangeable with electorates; a crosswalk needs a dated method and weights.';

create table evidence_private.stat_observations (
  id bigint generated always as identity primary key,
  series_id uuid not null references evidence_private.stat_series (id),
  release_id uuid not null references evidence_private.stat_releases (id),
  geography_version_id uuid references evidence_private.geography_versions (id),
  period_label text not null,
  period_start date,
  period_end date,
  value numeric(38, 12),
  value_double double precision,
  raw_value text,
  value_status text not null check (value_status in (
    'reported', 'provisional', 'suppressed', 'confidential', 'missing', 'not_applicable')),
  parse_status text not null check (parse_status in ('parsed', 'unparsed_symbol', 'rejected')),
  row_locator text,
  content_hash text not null check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_route text not null check (canonical_route in ('dedicated_census', 'dedicated_series', 'operational')),
  import_run_id uuid not null references evidence_private.import_runs (id),
  -- A number exists only for reported or provisional values.
  check ((value_status in ('reported', 'provisional')) = (value is not null or value_double is not null))
);

create unique index stat_observations_identity on evidence_private.stat_observations (
  series_id, release_id, coalesce(geography_version_id, '00000000-0000-0000-0000-000000000000'::uuid), period_label);

create index stat_observations_series_period on evidence_private.stat_observations (series_id, period_start);

-- One canonical import route per observation family, decided before import.
create table evidence_private.stat_route_reconciliation (
  observation_family text primary key,
  canonical_route text not null check (canonical_route in ('dedicated_census', 'dedicated_series', 'operational')),
  overlapping_routes text[] not null default '{}',
  upstream_rows_by_route jsonb not null default '{}'::jsonb,
  decision_note text not null,
  decided_by text not null,
  decided_at timestamptz not null default now()
);

comment on table evidence_private.stat_route_reconciliation is
  'Dedicated statistics tables overlap operational records upstream. A family is imported through exactly one route; counts from overlapping routes are never added together.';

create or replace function evidence_private.guard_stat_route()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_family text;
  v_route text;
begin
  select d.dataset_key into v_family
  from evidence_private.stat_series s
  join evidence_private.stat_datasets d on d.id = s.dataset_id
  where s.id = new.series_id;

  select r.canonical_route into v_route
  from evidence_private.stat_route_reconciliation r
  where r.observation_family = v_family;

  if v_route is null then
    raise exception 'no reconciled import route recorded for observation family %', v_family
      using errcode = 'P0001';
  end if;
  if v_route <> new.canonical_route then
    raise exception 'observation family % is imported through route %, not %', v_family, v_route, new.canonical_route
      using errcode = 'P0001';
  end if;
  return new;
end
$$;

create trigger stat_observations_route_guard
  before insert on evidence_private.stat_observations
  for each row execute function evidence_private.guard_stat_route();
