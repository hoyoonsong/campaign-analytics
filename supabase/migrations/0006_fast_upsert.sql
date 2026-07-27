-- Free-tier safe set-based upsert (replaces slow row-by-row PL/pgSQL loop).
-- Prefer murmuration_id conflict; fallback path for voter_id-only rows.
-- Note: murmuration_id uses a partial unique index, so ON CONFLICT must include the same predicate.

-- Ensure a real unique constraint for murmuration_id when possible (empty strings normalized to null).
update public.voters set murmuration_id = null where murmuration_id = '';
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'voters_murmuration_id_key'
      and conrelid = 'public.voters'::regclass
  ) then
    begin
      alter table public.voters
        add constraint voters_murmuration_id_key unique (murmuration_id);
    exception when others then
      -- Partial unique index remains usable via inferred ON CONFLICT ... WHERE
      null;
    end;
  end if;
end;
$$;

create or replace function public.voter_upsert_batch(rows jsonb, batch_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_in int;
  inserted int := 0;
  updated int := 0;
  skipped int := 0;
  ins_mid int := 0;
  upd_mid int := 0;
  ins_vid int := 0;
  upd_vid int := 0;
begin
  -- Allow larger batches without default short statement kills where possible.
  perform set_config('statement_timeout', '90s', true);

  if rows is null or jsonb_typeof(rows) <> 'array' then
    return jsonb_build_object('error', 'rows must be a jsonb array');
  end if;

  n_in := jsonb_array_length(rows);
  if n_in = 0 then
    return jsonb_build_object('inserted', 0, 'updated', 0, 'skipped', 0, 'errors', '[]'::jsonb);
  end if;
  if n_in > 250 then
    return jsonb_build_object('error', 'Max 250 rows per batch');
  end if;

  drop table if exists _voter_import;
  create temporary table _voter_import (
    murmuration_id text,
    voter_id text,
    first_name text,
    last_name text,
    email text,
    phone text,
    age smallint,
    address_line_1 text,
    city text,
    county text,
    zip text,
    state text,
    lat double precision,
    lng double precision,
    party text,
    voter_registered text,
    status text,
    sig_open_primaries text,
    sig_reproductive_freedom text,
    sig_achilles_petition text,
    sig_medical_cannabis text,
    sig_medical_marijuana_valid_code text,
    sig_reproductive_freedom_valid_code text,
    volunteer_interest text,
    yard_sign text,
    support_score smallint,
    newsletter text,
    legacy_volunteer text,
    alignment_score text,
    top_main_topic text,
    alignment_label text,
    contact_tags text,
    convos_candidate_support text,
    convos_contact_status text,
    convos_poll_question text,
    donated text,
    attended_event text
  ) on commit drop;

  insert into _voter_import
  select
    nullif(trim(x.murmuration_id), ''),
    nullif(trim(x.voter_id), ''),
    nullif(trim(x.first_name), ''),
    nullif(trim(x.last_name), ''),
    nullif(trim(x.email), ''),
    nullif(trim(x.phone), ''),
    x.age,
    nullif(trim(x.address_line_1), ''),
    nullif(trim(x.city), ''),
    nullif(trim(x.county), ''),
    nullif(trim(x.zip), ''),
    nullif(upper(left(trim(coalesce(x.state, '')), 2)), ''),
    x.lat,
    x.lng,
    nullif(trim(x.party), ''),
    nullif(trim(x.voter_registered), ''),
    nullif(trim(x.status), ''),
    nullif(trim(x.sig_open_primaries), ''),
    nullif(trim(x.sig_reproductive_freedom), ''),
    nullif(trim(x.sig_achilles_petition), ''),
    nullif(trim(x.sig_medical_cannabis), ''),
    nullif(trim(x.sig_medical_marijuana_valid_code), ''),
    nullif(trim(x.sig_reproductive_freedom_valid_code), ''),
    nullif(trim(x.volunteer_interest), ''),
    nullif(trim(x.yard_sign), ''),
    x.support_score,
    nullif(trim(x.newsletter), ''),
    nullif(trim(x.legacy_volunteer), ''),
    nullif(trim(x.alignment_score), ''),
    nullif(trim(x.top_main_topic), ''),
    nullif(trim(x.alignment_label), ''),
    nullif(trim(x.contact_tags), ''),
    nullif(trim(x.convos_candidate_support), ''),
    nullif(trim(x.convos_contact_status), ''),
    nullif(trim(x.convos_poll_question), ''),
    nullif(trim(x.donated), ''),
    nullif(trim(x.attended_event), '')
  from jsonb_to_recordset(rows) as x(
    murmuration_id text,
    voter_id text,
    first_name text,
    last_name text,
    email text,
    phone text,
    age smallint,
    address_line_1 text,
    city text,
    county text,
    zip text,
    state text,
    lat double precision,
    lng double precision,
    party text,
    voter_registered text,
    status text,
    sig_open_primaries text,
    sig_reproductive_freedom text,
    sig_achilles_petition text,
    sig_medical_cannabis text,
    sig_medical_marijuana_valid_code text,
    sig_reproductive_freedom_valid_code text,
    volunteer_interest text,
    yard_sign text,
    support_score smallint,
    newsletter text,
    legacy_volunteer text,
    alignment_score text,
    top_main_topic text,
    alignment_label text,
    contact_tags text,
    convos_candidate_support text,
    convos_contact_status text,
    convos_poll_question text,
    donated text,
    attended_event text
  );

  select count(*) into skipped from _voter_import
  where murmuration_id is null and voter_id is null;

  delete from _voter_import where murmuration_id is null and voter_id is null;

  -- 1) Upsert rows that have murmuration_id
  with src as (
    select distinct on (murmuration_id) *
    from _voter_import
    where murmuration_id is not null
    order by murmuration_id
  ),
  upserted as (
    insert into public.voters as v (
      murmuration_id, voter_id, first_name, last_name, email, phone, age,
      address_line_1, city, county, zip, state, lat, lng,
      party, voter_registered, status,
      sig_open_primaries, sig_reproductive_freedom, sig_achilles_petition,
      sig_medical_cannabis, sig_medical_marijuana_valid_code,
      sig_reproductive_freedom_valid_code,
      volunteer_interest, yard_sign, support_score, newsletter,
      legacy_volunteer, alignment_score, top_main_topic, alignment_label,
      contact_tags, convos_candidate_support, convos_contact_status,
      convos_poll_question, donated, attended_event
    )
    select
      murmuration_id, voter_id, first_name, last_name, email, phone, age,
      address_line_1, city, county, zip, state, lat, lng,
      party, voter_registered, status,
      sig_open_primaries, sig_reproductive_freedom, sig_achilles_petition,
      sig_medical_cannabis, sig_medical_marijuana_valid_code,
      sig_reproductive_freedom_valid_code,
      volunteer_interest, yard_sign, support_score, newsletter,
      legacy_volunteer, alignment_score, top_main_topic, alignment_label,
      contact_tags, convos_candidate_support, convos_contact_status,
      convos_poll_question, donated, attended_event
    from src
    on conflict (murmuration_id) where murmuration_id is not null and murmuration_id <> ''
    do update set
      voter_id = coalesce(excluded.voter_id, v.voter_id),
      first_name = coalesce(excluded.first_name, v.first_name),
      last_name = coalesce(excluded.last_name, v.last_name),
      email = coalesce(excluded.email, v.email),
      phone = coalesce(excluded.phone, v.phone),
      age = coalesce(excluded.age, v.age),
      address_line_1 = coalesce(excluded.address_line_1, v.address_line_1),
      city = coalesce(excluded.city, v.city),
      county = coalesce(excluded.county, v.county),
      zip = coalesce(excluded.zip, v.zip),
      state = coalesce(excluded.state, v.state),
      lat = coalesce(excluded.lat, v.lat),
      lng = coalesce(excluded.lng, v.lng),
      party = coalesce(excluded.party, v.party),
      voter_registered = coalesce(excluded.voter_registered, v.voter_registered),
      status = coalesce(excluded.status, v.status),
      sig_open_primaries = coalesce(excluded.sig_open_primaries, v.sig_open_primaries),
      sig_reproductive_freedom = coalesce(excluded.sig_reproductive_freedom, v.sig_reproductive_freedom),
      sig_achilles_petition = coalesce(excluded.sig_achilles_petition, v.sig_achilles_petition),
      sig_medical_cannabis = coalesce(excluded.sig_medical_cannabis, v.sig_medical_cannabis),
      sig_medical_marijuana_valid_code = coalesce(excluded.sig_medical_marijuana_valid_code, v.sig_medical_marijuana_valid_code),
      sig_reproductive_freedom_valid_code = coalesce(excluded.sig_reproductive_freedom_valid_code, v.sig_reproductive_freedom_valid_code),
      volunteer_interest = coalesce(excluded.volunteer_interest, v.volunteer_interest),
      yard_sign = coalesce(excluded.yard_sign, v.yard_sign),
      support_score = coalesce(excluded.support_score, v.support_score),
      newsletter = coalesce(excluded.newsletter, v.newsletter),
      legacy_volunteer = coalesce(excluded.legacy_volunteer, v.legacy_volunteer),
      alignment_score = coalesce(excluded.alignment_score, v.alignment_score),
      top_main_topic = coalesce(excluded.top_main_topic, v.top_main_topic),
      alignment_label = coalesce(excluded.alignment_label, v.alignment_label),
      contact_tags = coalesce(excluded.contact_tags, v.contact_tags),
      convos_candidate_support = coalesce(excluded.convos_candidate_support, v.convos_candidate_support),
      convos_contact_status = coalesce(excluded.convos_contact_status, v.convos_contact_status),
      convos_poll_question = coalesce(excluded.convos_poll_question, v.convos_poll_question),
      donated = coalesce(excluded.donated, v.donated),
      attended_event = coalesce(excluded.attended_event, v.attended_event),
      updated_at = now()
    returning (xmax = 0) as was_insert
  )
  select
    count(*) filter (where was_insert),
    count(*) filter (where not was_insert)
  into ins_mid, upd_mid
  from upserted;

  -- 2) Rows with voter_id only (no murmuration_id)
  with src as (
    select distinct on (voter_id) *
    from _voter_import
    where murmuration_id is null and voter_id is not null
    order by voter_id
  ),
  upserted as (
    insert into public.voters as v (
      murmuration_id, voter_id, first_name, last_name, email, phone, age,
      address_line_1, city, county, zip, state, lat, lng,
      party, voter_registered, status,
      sig_open_primaries, sig_reproductive_freedom, sig_achilles_petition,
      sig_medical_cannabis, sig_medical_marijuana_valid_code,
      sig_reproductive_freedom_valid_code,
      volunteer_interest, yard_sign, support_score, newsletter,
      legacy_volunteer, alignment_score, top_main_topic, alignment_label,
      contact_tags, convos_candidate_support, convos_contact_status,
      convos_poll_question, donated, attended_event
    )
    select
      murmuration_id, voter_id, first_name, last_name, email, phone, age,
      address_line_1, city, county, zip, state, lat, lng,
      party, voter_registered, status,
      sig_open_primaries, sig_reproductive_freedom, sig_achilles_petition,
      sig_medical_cannabis, sig_medical_marijuana_valid_code,
      sig_reproductive_freedom_valid_code,
      volunteer_interest, yard_sign, support_score, newsletter,
      legacy_volunteer, alignment_score, top_main_topic, alignment_label,
      contact_tags, convos_candidate_support, convos_contact_status,
      convos_poll_question, donated, attended_event
    from src
    on conflict (voter_id) do update set
      first_name = coalesce(excluded.first_name, v.first_name),
      last_name = coalesce(excluded.last_name, v.last_name),
      email = coalesce(excluded.email, v.email),
      phone = coalesce(excluded.phone, v.phone),
      age = coalesce(excluded.age, v.age),
      address_line_1 = coalesce(excluded.address_line_1, v.address_line_1),
      city = coalesce(excluded.city, v.city),
      county = coalesce(excluded.county, v.county),
      zip = coalesce(excluded.zip, v.zip),
      state = coalesce(excluded.state, v.state),
      lat = coalesce(excluded.lat, v.lat),
      lng = coalesce(excluded.lng, v.lng),
      party = coalesce(excluded.party, v.party),
      voter_registered = coalesce(excluded.voter_registered, v.voter_registered),
      status = coalesce(excluded.status, v.status),
      sig_open_primaries = coalesce(excluded.sig_open_primaries, v.sig_open_primaries),
      sig_reproductive_freedom = coalesce(excluded.sig_reproductive_freedom, v.sig_reproductive_freedom),
      sig_achilles_petition = coalesce(excluded.sig_achilles_petition, v.sig_achilles_petition),
      sig_medical_cannabis = coalesce(excluded.sig_medical_cannabis, v.sig_medical_cannabis),
      sig_medical_marijuana_valid_code = coalesce(excluded.sig_medical_marijuana_valid_code, v.sig_medical_marijuana_valid_code),
      sig_reproductive_freedom_valid_code = coalesce(excluded.sig_reproductive_freedom_valid_code, v.sig_reproductive_freedom_valid_code),
      volunteer_interest = coalesce(excluded.volunteer_interest, v.volunteer_interest),
      yard_sign = coalesce(excluded.yard_sign, v.yard_sign),
      support_score = coalesce(excluded.support_score, v.support_score),
      newsletter = coalesce(excluded.newsletter, v.newsletter),
      legacy_volunteer = coalesce(excluded.legacy_volunteer, v.legacy_volunteer),
      alignment_score = coalesce(excluded.alignment_score, v.alignment_score),
      top_main_topic = coalesce(excluded.top_main_topic, v.top_main_topic),
      alignment_label = coalesce(excluded.alignment_label, v.alignment_label),
      contact_tags = coalesce(excluded.contact_tags, v.contact_tags),
      convos_candidate_support = coalesce(excluded.convos_candidate_support, v.convos_candidate_support),
      convos_contact_status = coalesce(excluded.convos_contact_status, v.convos_contact_status),
      convos_poll_question = coalesce(excluded.convos_poll_question, v.convos_poll_question),
      donated = coalesce(excluded.donated, v.donated),
      attended_event = coalesce(excluded.attended_event, v.attended_event),
      updated_at = now()
    returning (xmax = 0) as was_insert
  )
  select
    count(*) filter (where was_insert),
    count(*) filter (where not was_insert)
  into ins_vid, upd_vid
  from upserted;

  inserted := coalesce(ins_mid, 0) + coalesce(ins_vid, 0);
  updated := coalesce(upd_mid, 0) + coalesce(upd_vid, 0);

  if batch_id is not null then
    update public.voter_import_batches set
      total_rows = coalesce(total_rows, 0) + n_in,
      inserted_rows = coalesce(inserted_rows, 0) + inserted,
      updated_rows = coalesce(updated_rows, 0) + updated,
      skipped_rows = coalesce(skipped_rows, 0) + skipped,
      status = 'running',
      updated_at = now()
    where id = batch_id;
  end if;

  return jsonb_build_object(
    'inserted', inserted,
    'updated', updated,
    'skipped', skipped,
    'errors', '[]'::jsonb
  );
end;
$$;

revoke all on function public.voter_upsert_batch(jsonb, uuid) from public;
grant execute on function public.voter_upsert_batch(jsonb, uuid) to service_role;
