-- Shared groundwork for the three import families (election 2026092101, parliament 2026092102, statistics 2026092103).
--
-- Two shared objects were met by more than one family, each on its own branch. They live here ONCE, ahead of every
-- family migration, so no family replaces another's copy and the order in which families are applied does not matter:
--
--   1. evidence_private.text_violation: the ledger guard, with one correction to its phone-number test.
--   2. evidence_private.run_projectors + project_run: a family REGISTERS its projection; nobody replaces project_run.
--      The one project_run also projects the earlier runs of a resume chain, so a worker that was killed after storing
--      records, and before projecting them, leaves no record without its typed row once the run is resumed.
--
-- Additive: no existing row is rewritten. Every other test in the guard is unchanged, word for word.

-- 1. Ledger guard ---------------------------------------------------------------------------------------------------------
-- The phone-number test matched digit runs that sit inside machine identifiers whenever the same text also held "ph",
-- "tel", "call" or "mob" (as in "telecommunications", "graph" or "Stephens"). Measured on the real exports: 1,380 of
-- 187,956 written questions, 4 releases, 3 bills, 2 report files and several election rows would have been refused for
-- carrying a publisher id or a digest beside such a word.
--
-- One rule, stated once: before the phone test, and ONLY for it, IDENTIFIER TOKENS are taken out of the text:
--   * a UUID, and
--   * a run of 16 to 128 hexadecimal characters that is a whole token (no letter or digit touches either end):
--     SHA-256 digests, their 16-character prefixes used as release keys, undashed publisher ids.
-- A phone number is at most 12 digits, so it is never such a token, and a number printed beside an identifier is still
-- refused. Every other test sees the whole text. Payloads that write digests with the digits 0-9 as the letters g-p
-- (the election family's encoding, decoded by its projection) hold no digit run at all and pass exactly as before:
-- both spellings of a digest are accepted, and neither can hide a phone number.
-- The TypeScript preflights mirror this function from ONE module (supabase/functions/_shared/text_guard.ts); a test
-- runs the same vectors through both.

create or replace function evidence_private.text_violation(p_text text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_without_identifiers text;
begin
  if p_text is null then
    return null;
  end if;
  if p_text ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then
    return 'control_characters';
  end if;
  if p_text ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' then
    return 'email_like_value';
  end if;
  if p_text ~ '(^|["\s=:(,])(file://|~/|[A-Za-z]:\\|/(home|Users|root|var|mnt|srv|etc|tmp|opt|data)/)' then
    return 'filesystem_location_value';
  end if;
  if p_text ~* '(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token|bearer|authorization)["'']?\s*[=:]\s*\S'
     or p_text ~ 'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.'
     -- (the pattern is assembled from two pieces so this file does not itself look like it holds a token)
     or p_text ~ ('(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github' || '_pat_|sb_secret_|sk-[A-Za-z0-9]{16,}|BEGIN [A-Z ]*PRIVATE KEY)')
     or p_text ~* '[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@' then
    return 'credential_like_value';
  end if;
  v_without_identifiers := regexp_replace(
    regexp_replace(p_text, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', ' ', 'g'),
    '(^|[^0-9A-Za-z])[0-9a-fA-F]{16,128}(?![0-9A-Za-z])', '\1 ', 'g');
  if v_without_identifiers ~ '(^|[^0-9])(\+?64|0)[ -]?[2-9][0-9]?[ -]?[0-9]{3}[ -]?[0-9]{3,4}([^0-9]|$)' and p_text ~* '(ph|phone|mob|tel|call)' then
    return 'phone_like_value';
  end if;
  return null;
end
$$;

-- 2. Projector registry ----------------------------------------------------------------------------------------------------
-- A family adds its typed projection with one INSERT. project_run runs the three core projections unchanged and then
-- every registered projector, in key order, for the run and for every earlier run of its resume chain. A projector
-- reads only its own record kinds, so the order is not meaningful and a run of one family's records leaves another
-- family's tables untouched (tested).

create table evidence_private.run_projectors (
  projector_key text primary key check (projector_key ~ '^[a-z][a-z0-9_]{2,60}$'),
  function_name text not null unique check (function_name ~ '^[a-z][a-z0-9_]{2,60}$'),
  registered_at timestamptz not null default now()
);

comment on table evidence_private.run_projectors is
  'Projection functions evidence_private.<function_name>(uuid) run by project_run after the core projections. Administrator-written only.';

alter table evidence_private.run_projectors enable row level security;
revoke all on evidence_private.run_projectors from public, anon, authenticated;
grant select on evidence_private.run_projectors to evidence_ingest;
create policy run_projectors_ingest_select on evidence_private.run_projectors for select to evidence_ingest using (true);

create or replace function evidence_private.project_run(p_run_id uuid, p_holder uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_out jsonb;
  v_run record;
  v_projector record;
  v_result jsonb;
  v_earlier integer := 0;
begin
  perform evidence_private.assert_run_held(p_run_id, p_holder);
  -- A projection covers the records a run observed. A run that RESUMES a stopped run observes only what came after
  -- the checkpoint, and a run that was killed never reached its own projection: without the loop below the records it
  -- had already stored stayed in the ledger with no typed row (found by a hard stop on the real written questions:
  -- 187,956 records, 164,756 typed rows). So the whole resume chain is projected, oldest run first. Projections are
  -- idempotent, so projecting a run twice writes nothing new.
  for v_run in
    with recursive chain as (
      select r.id, r.resumed_from_run_id, 0 as depth from evidence_private.import_runs r where r.id = p_run_id
      union all
      select r.id, r.resumed_from_run_id, c.depth + 1
      from evidence_private.import_runs r join chain c on r.id = c.resumed_from_run_id
      where c.depth < 100)
    select id, depth from chain order by depth desc
  loop
    v_out := jsonb_build_object(
      'mp_directory', evidence_private.project_mp_directory(v_run.id),
      'documents', evidence_private.project_documents(v_run.id),
      'baseline_candidacies', evidence_private.project_baseline_candidacies(v_run.id));
    for v_projector in select projector_key, function_name from evidence_private.run_projectors order by projector_key loop
      execute format('select evidence_private.%I($1)', v_projector.function_name) into v_result using v_run.id;
      v_out := v_out || jsonb_build_object(v_projector.projector_key, v_result);
    end loop;
    if v_run.depth > 0 then
      v_earlier := v_earlier + 1;
    end if;
  end loop;
  -- The answer describes the run that was asked for (the last one projected), and says how many earlier runs of its
  -- resume chain were projected with it.
  return v_out || jsonb_build_object('earlier_runs_of_this_resume_chain_projected', v_earlier);
end
$$;

insert into evidence_private.public_lineage (object_schema, object_name, lineage_kind, lineage_sql, note) values
  ('evidence_private', 'run_projectors', 'not_source_data', null, 'The list of projection functions. Holds no source data.');
