-- Source registry, rights, run ledger, leases, checkpoints, immutable versions,
-- repeated observations, lifecycle (tombstone) events and freshness.

-- Rights ---------------------------------------------------------------------

create table evidence_private.source_rights (
  rights_id text primary key check (rights_id ~ '^RIGHTS-[0-9]{2,}$'),
  publisher text not null,
  source_url text not null check (source_url ~ '^https://'),
  review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'restricted', 'refused')),
  default_release text not null default 'link-only'
    check (default_release in ('link-only', 'approved-fields', 'withheld')),
  licence_or_terms_url text,
  verified_permissions text,
  excluded_assets text,
  attribution text,
  reviewed_on date,
  -- Field tokens a publisher has cleared for release. Empty unless the review is approved AND the
  -- release mode is approved-fields. Nothing but link metadata is public without an entry here.
  approved_fields text[] not null default '{}',
  register_hash text not null,
  synced_at timestamptz not null default now(),
  -- A rights row cannot leave pending without a dated review.
  check (review_status = 'pending' or reviewed_on is not null),
  check (cardinality(approved_fields) = 0 or (review_status = 'approved' and default_release = 'approved-fields')),
  check (array_to_string(approved_fields, ',') ~ '^[a-z][a-z0-9_,]*$' or cardinality(approved_fields) = 0)
);

comment on table evidence_private.source_rights is
  'Mirror of catalogue/rights-register.json. Synced, never edited by hand. Pending stays pending until the register itself records a review.';

create table evidence_private.rights_decisions (
  id uuid primary key default gen_random_uuid(),
  rights_id text not null references evidence_private.source_rights (rights_id),
  decision text not null check (decision in ('pending', 'approved_link_only', 'approved_fields', 'refused')),
  scope_fields text[] not null default '{}',
  decided_by text not null,
  decided_at timestamptz not null default now(),
  evidence_url text,
  note text
);

create trigger rights_decisions_append_only
  before update or delete on evidence_private.rights_decisions
  for each row execute function evidence_private.reject_mutation();

-- Registry -------------------------------------------------------------------

create table evidence_private.registry_products (
  registry_key text primary key,
  title text not null,
  domain text not null,
  notes text
);

create table evidence_private.sources (
  source_id text primary key check (source_id ~ '^[a-z][a-z0-9_]{2,62}$'),
  registry_key text references evidence_private.registry_products (registry_key),
  title text not null,
  publisher text not null,
  official_url text not null check (official_url ~ '^https://'),
  adapter_kind text not null check (adapter_kind in ('live_fetch', 'export_import')),
  adapter_name text not null,
  allowed_hosts text[] not null check (cardinality(allowed_hosts) > 0 or adapter_kind = 'export_import'),
  rights_id text references evidence_private.source_rights (rights_id),
  access_basis text check (access_basis in ('public_page', 'public_feed', 'documented_api', 'undocumented_endpoint')),
  view_scope text not null check (view_scope in (
    'primary_2026', 'baseline_2023', 'finance_2025', 'current_parliament', 'statistics', 'general')),
  expected_cadence_seconds integer check (expected_cadence_seconds is null or expected_cadence_seconds >= 300),
  snapshot_semantics text not null check (snapshot_semantics in ('complete_snapshot', 'rolling_window', 'append_only_feed')),
  enabled boolean not null default false,
  blocked_reason text,
  config_hash text not null,
  synced_at timestamptz not null default now(),
  -- A source that contacts a publisher must name its rights row and the basis for automated access.
  check (adapter_kind <> 'live_fetch' or (rights_id is not null and access_basis is not null)),
  -- An internal endpoint with no published terms is never enabled.
  check (access_basis is distinct from 'undocumented_endpoint' or (not enabled and blocked_reason is not null))
);

comment on column evidence_private.sources.access_basis is
  'What this project has established about automated access. undocumented_endpoint is never fetched. A value here is not a legal approval; see publisher_terms_reviews.';
comment on column evidence_private.sources.view_scope is
  'Keeps the 2026 primary view apart from the 2023 baseline and 2025 finance material. Never merged for display.';
comment on column evidence_private.sources.snapshot_semantics is
  'Only complete_snapshot sources may tombstone absent records. Feeds and rolling windows never imply deletion.';
comment on column evidence_private.sources.allowed_hosts is
  'Exact HTTPS hostnames the adapter may contact. Enforced in the fetch layer and recorded per request.';

create table evidence_private.catalogue_product_map (
  source_id text not null references evidence_private.sources (source_id),
  product_id text not null check (product_id ~ '^P[0-9]{2}$'),
  mapping_note text not null,
  primary key (source_id, product_id)
);

comment on table evidence_private.catalogue_product_map is
  'Explicit mapping between operational source IDs and public catalogue product IDs. The two ID spaces are not assumed equal.';

-- Run ledger -----------------------------------------------------------------

create table evidence_private.import_runs (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references evidence_private.sources (source_id),
  adapter_version text not null,
  mode text not null check (mode in ('incremental', 'backfill', 'export_import')),
  trigger_kind text not null check (trigger_kind in ('cron', 'cli', 'test')),
  holder uuid not null,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'partial', 'failed', 'blocked', 'abandoned')),
  complete_snapshot boolean,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  resumed_from_run_id uuid references evidence_private.import_runs (id),
  manifest_hash text,
  source_watermark text,
  records_seen integer not null default 0,
  versions_inserted integer not null default 0,
  observations_inserted integer not null default 0,
  unchanged integer not null default 0,
  rejected integer not null default 0,
  tombstoned integer not null default 0,
  error_class text check (error_class is null or error_class ~ '^[a-z][a-z0-9_]{1,60}$'),
  error_detail text,
  check ((status = 'running') = (finished_at is null)),
  -- A blocked or failed run can never claim to be a complete snapshot.
  check (complete_snapshot is not true or status = 'succeeded')
);

create index import_runs_source_started on evidence_private.import_runs (source_id, started_at desc);

comment on column evidence_private.import_runs.status is
  'blocked = the publisher endpoint refused or challenged the request. It is an availability fact, never evidence that no records exist.';

create table evidence_private.run_checkpoints (
  run_id uuid not null references evidence_private.import_runs (id),
  seq integer not null check (seq >= 0),
  cursor_state jsonb not null,
  records_so_far integer not null,
  created_at timestamptz not null default now(),
  primary key (run_id, seq)
);

create trigger run_checkpoints_append_only
  before update or delete on evidence_private.run_checkpoints
  for each row execute function evidence_private.reject_mutation();

create table evidence_private.source_leases (
  source_id text primary key references evidence_private.sources (source_id),
  holder uuid not null,
  run_id uuid references evidence_private.import_runs (id),
  acquired_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null
);

comment on table evidence_private.source_leases is
  'One live lease per source prevents overlapping runs. Expired leases can be taken over; the abandoned run is marked as such.';

create table evidence_private.fetch_log (
  id bigint generated always as identity primary key,
  run_id uuid references evidence_private.import_runs (id),
  source_id text not null references evidence_private.sources (source_id),
  request_method text not null check (request_method in ('GET', 'POST')),
  request_url text not null check (request_url ~ '^https://'),
  request_host text not null,
  attempt integer not null check (attempt >= 1),
  outcome text not null check (outcome in (
    'ok', 'not_modified', 'blocked', 'challenge', 'http_error', 'network_error',
    'timeout', 'too_large', 'host_denied', 'parse_error',
    'robots_disallowed', 'robots_unavailable', 'robots_crawl_delay_exceeds_budget')),
  http_status integer,
  response_bytes bigint,
  body_sha256 text,
  retrieved_at timestamptz not null,
  duration_ms integer
);

create index fetch_log_run on evidence_private.fetch_log (run_id);
create index fetch_log_source_time on evidence_private.fetch_log (source_id, retrieved_at desc);

create trigger fetch_log_append_only
  before update or delete on evidence_private.fetch_log
  for each row execute function evidence_private.reject_mutation();

create table evidence_private.ingest_errors (
  id bigint generated always as identity primary key,
  run_id uuid references evidence_private.import_runs (id),
  source_id text not null references evidence_private.sources (source_id),
  error_class text not null,
  message text not null check (length(message) <= 2000),
  record_ref text,
  occurred_at timestamptz not null default now()
);

create index ingest_errors_source_time on evidence_private.ingest_errors (source_id, occurred_at desc);

create trigger ingest_errors_append_only
  before update or delete on evidence_private.ingest_errors
  for each row execute function evidence_private.reject_mutation();

-- Records, immutable versions, observations ----------------------------------

create table evidence_private.source_records (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references evidence_private.sources (source_id),
  external_record_id text not null check (length(external_record_id) between 1 and 400),
  record_kind text not null,
  current_version_id uuid,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  tombstoned_at timestamptz,
  tombstone_reason text,
  unique (source_id, external_record_id),
  check ((tombstoned_at is null) = (tombstone_reason is null))
);

create table evidence_private.source_record_versions (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references evidence_private.source_records (id),
  content_hash text not null check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  original_content_hash text,
  record_kind text not null,
  source_url text not null check (source_url ~ '^https://'),
  -- The publisher's own date for the item. Null when the source states none.
  source_published_at timestamptz,
  source_date_text text,
  -- When this project first retrieved this exact content. Independent of the above.
  first_retrieved_at timestamptz not null,
  loaded_at timestamptz not null default now(),
  import_run_id uuid not null references evidence_private.import_runs (id),
  predecessor_id uuid references evidence_private.source_record_versions (id),
  projection_version integer not null check (projection_version >= 1),
  safe_payload jsonb not null check (jsonb_typeof(safe_payload) = 'object'),
  omitted_fields jsonb not null default '[]'::jsonb check (jsonb_typeof(omitted_fields) = 'array'),
  unique (record_id, content_hash),
  unique (id, record_id)
);

comment on column evidence_private.source_record_versions.content_hash is
  'SHA-256 over the canonical allowlisted projection. Timestamp-only refreshes produce the same hash and therefore no new version.';
comment on column evidence_private.source_record_versions.original_content_hash is
  'Identifier carried over from an upstream export. It was computed over the upstream payload, not over this projection.';
comment on column evidence_private.source_record_versions.omitted_fields is
  'Names and reasons of fields deliberately left out of safe_payload. Values are never stored.';

-- The current pointer must reference a version of the same record.
alter table evidence_private.source_records
  add constraint source_records_current_version_same_record
  foreign key (current_version_id, id)
  references evidence_private.source_record_versions (id, record_id)
  deferrable initially deferred;

create index source_records_kind on evidence_private.source_records (source_id, record_kind);
create index source_record_versions_record on evidence_private.source_record_versions (record_id, first_retrieved_at desc);
create index source_record_versions_run on evidence_private.source_record_versions (import_run_id);

create trigger source_record_versions_append_only
  before update or delete on evidence_private.source_record_versions
  for each row execute function evidence_private.reject_mutation();

create table evidence_private.source_observations (
  version_id uuid not null references evidence_private.source_record_versions (id),
  run_id uuid not null references evidence_private.import_runs (id),
  observed_at timestamptz not null,
  primary key (version_id, run_id)
);

create index source_observations_run on evidence_private.source_observations (run_id);

create trigger source_observations_append_only
  before update or delete on evidence_private.source_observations
  for each row execute function evidence_private.reject_mutation();

create table evidence_private.record_lifecycle_events (
  id bigint generated always as identity primary key,
  record_id uuid not null references evidence_private.source_records (id),
  run_id uuid references evidence_private.import_runs (id),
  event text not null check (event in ('tombstoned', 'reappeared', 'redacted')),
  reason text not null,
  -- Who asked for a redaction. Kept for audit, withheld from the public projections.
  requested_by text,
  occurred_at timestamptz not null default now()
);

create index record_lifecycle_events_record on evidence_private.record_lifecycle_events (record_id, occurred_at);

create trigger record_lifecycle_events_append_only
  before update or delete on evidence_private.record_lifecycle_events
  for each row execute function evidence_private.reject_mutation();

comment on table evidence_private.record_lifecycle_events is
  'Tombstones mark a record as absent from a complete official snapshot. History is kept; nothing is deleted. Redaction is the documented erasure path.';

-- Freshness ------------------------------------------------------------------

create table evidence_private.source_freshness (
  source_id text primary key references evidence_private.sources (source_id),
  last_attempt_at timestamptz,
  last_attempt_status text,
  last_attempt_run_id uuid references evidence_private.import_runs (id),
  last_success_at timestamptz,
  last_success_run_id uuid references evidence_private.import_runs (id),
  last_change_at timestamptz,
  latest_source_published_at timestamptz,
  consecutive_failures integer not null default 0,
  last_error_class text
);

comment on column evidence_private.source_freshness.last_success_at is
  'Retrieval time of the last successful run. Says nothing about the dates of the underlying events.';
comment on column evidence_private.source_freshness.latest_source_published_at is
  'Latest publisher-stated date seen in any version. Null means the source states no dates, not that nothing was published.';
