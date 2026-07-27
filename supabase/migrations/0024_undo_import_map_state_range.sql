-- Undo imports, stamp inserts, skip almost none, map pins fast path,
-- nearby min/max range, state filter.

alter table public.voters
  add column if not exists import_batch_id uuid references public.voter_import_batches(id) on delete set null;

create index if not exists voters_import_batch_id_idx
  on public.voters (import_batch_id)
  where import_batch_id is not null;

alter table public.voter_import_batches
  add column if not exists undone_at timestamptz,
  add column if not exists undone_by text;

create or replace function public._has_nearby_geo_range(
  p_lat double precision,
  p_lng double precision,
  p_kind text,
  p_min_miles double precision,
  p_max_miles double precision
)
returns boolean
language sql
stable
as $$
  select case
    when p_lat is null or p_lng is null then false
    when (p_min_miles is null or p_min_miles <= 0) and p_max_miles is null then false
    else exists (
      select 1
      from public.campaign_geo_points g
      where g.kind = p_kind
        and g.lat between p_lat - (coalesce(p_max_miles, 500) / 69.0)
                      and p_lat + (coalesce(p_max_miles, 500) / 69.0)
        and g.lng between p_lng - (coalesce(p_max_miles, 500) / (69.0 * greatest(cos(radians(p_lat)), 0.2)))
                      and p_lng + (coalesce(p_max_miles, 500) / (69.0 * greatest(cos(radians(p_lat)), 0.2)))
        and public._miles_between(p_lat, p_lng, g.lat, g.lng) >= coalesce(p_min_miles, 0)
        and (p_max_miles is null or public._miles_between(p_lat, p_lng, g.lat, g.lng) <= p_max_miles)
      limit 1
    )
  end;
$$;

create or replace function public.undo_voter_import_batch(p_batch_id uuid, p_actor text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_deleted int := 0;
begin
  perform set_config('statement_timeout', '120s', true);

  select status into v_status
  from public.voter_import_batches
  where id = p_batch_id
  for update;

  if v_status is null then
    return jsonb_build_object('error', 'Import batch not found');
  end if;
  if v_status = 'undone' then
    return jsonb_build_object('error', 'Import already undone');
  end if;

  delete from public.voters where import_batch_id = p_batch_id;
  get diagnostics v_deleted = row_count;

  update public.voter_import_batches set
    status = 'undone',
    undone_at = now(),
    undone_by = p_actor,
    updated_at = now()
  where id = p_batch_id;

  return jsonb_build_object('deleted', v_deleted);
end;
$$;

revoke all on function public.undo_voter_import_batch(uuid, text) from public;
grant execute on function public.undo_voter_import_batch(uuid, text) to service_role;

-- Fast map pins (no per-row voters_match_filters).
create or replace function public.voter_map_points(
  filters jsonb default '{}'::jsonb,
  lim int default 2500
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  f jsonb := coalesce(filters, '{}'::jsonb);
  safe_limit int := least(greatest(coalesce(lim, 2500), 1), 8000);
  total_with_coords bigint;
  rows_json jsonb;
  f_county text[]; f_party text[]; f_city text[]; f_zip text[]; f_status text[]; f_state text[];
  f_supporter_tag text[];
  f_nearby_yard double precision; f_nearby_vol double precision;
  f_nearby_yard_min double precision; f_nearby_vol_min double precision;
  has_filters boolean;
begin
  perform set_config('statement_timeout', '60s', true);

  f_county := public._lower_text_array(public._jsonb_text_array(f, 'county'));
  f_party := public._lower_text_array(public._jsonb_text_array(f, 'party'));
  f_city := public._lower_text_array(public._jsonb_text_array(f, 'city'));
  f_zip := public._jsonb_text_array(f, 'zip');
  f_status := public._lower_text_array(public._jsonb_text_array(f, 'status'));
  f_state := public._lower_text_array(public._jsonb_text_array(f, 'state'));
  f_supporter_tag := public._lower_text_array(public._jsonb_text_array(f, 'supporter_tag'));
  f_nearby_yard := coalesce(
    nullif(f->>'nearby_yard_sign_max_miles', '')::double precision,
    nullif(f->>'nearby_yard_sign_miles', '')::double precision
  );
  f_nearby_vol := coalesce(
    nullif(f->>'nearby_volunteer_max_miles', '')::double precision,
    nullif(f->>'nearby_volunteer_miles', '')::double precision
  );
  f_nearby_yard_min := nullif(f->>'nearby_yard_sign_min_miles', '')::double precision;
  f_nearby_vol_min := nullif(f->>'nearby_volunteer_min_miles', '')::double precision;

  has_filters :=
    f_county is not null or f_party is not null or f_city is not null or f_zip is not null
    or f_status is not null or f_state is not null or f_supporter_tag is not null
    or f_nearby_yard is not null or f_nearby_vol is not null
    or f_nearby_yard_min is not null or f_nearby_vol_min is not null
    or (f ? 'any_of' and jsonb_typeof(f->'any_of') = 'array' and jsonb_array_length(f->'any_of') > 0)
    or (f ? 'signed' and jsonb_typeof(f->'signed') = 'array' and jsonb_array_length(f->'signed') > 0);

  if not has_filters then
    select count(*) into total_with_coords
    from public.voters v
    where v.lat is not null and v.lng is not null;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb)
    into rows_json
    from (
      select id, murmuration_id, voter_id, first_name, last_name,
             address_line_1, city, county, zip, party, status, age, support_score, lat, lng
      from public.voters v
      where v.lat is not null and v.lng is not null
      order by v.id
      limit safe_limit
    ) t;
  else
    select count(*) into total_with_coords
    from public.voters v
    where v.lat is not null and v.lng is not null
      and public._arr_match(v.county, f_county, false)
      and public._arr_match(v.party, f_party, false)
      and public._arr_match(v.city, f_city, false)
      and (f_zip is null or v.zip = any (f_zip))
      and public._arr_match(v.status, f_status, false)
      and public._arr_match(v.state, f_state, false)
      and (
        f_supporter_tag is null
        or lower(coalesce(v.supporter_tag, '')) = any (f_supporter_tag)
      )
      and (
        (f_nearby_yard is null and f_nearby_yard_min is null)
        or public._has_nearby_geo_range(v.lat, v.lng, 'yard_sign', f_nearby_yard_min, f_nearby_yard)
      )
      and (
        (f_nearby_vol is null and f_nearby_vol_min is null)
        or public._has_nearby_geo_range(v.lat, v.lng, 'volunteer', f_nearby_vol_min, f_nearby_vol)
      )
      and (
        not (f ? 'any_of')
        or jsonb_typeof(f->'any_of') <> 'array'
        or jsonb_array_length(f->'any_of') = 0
        or public._voter_matches_any_of(v, f->'any_of')
      );

    select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb)
    into rows_json
    from (
      select id, murmuration_id, voter_id, first_name, last_name,
             address_line_1, city, county, zip, party, status, age, support_score, lat, lng
      from public.voters v
      where v.lat is not null and v.lng is not null
        and public._arr_match(v.county, f_county, false)
        and public._arr_match(v.party, f_party, false)
        and public._arr_match(v.city, f_city, false)
        and (f_zip is null or v.zip = any (f_zip))
        and public._arr_match(v.status, f_status, false)
        and public._arr_match(v.state, f_state, false)
        and (
          f_supporter_tag is null
          or lower(coalesce(v.supporter_tag, '')) = any (f_supporter_tag)
        )
        and (
          (f_nearby_yard is null and f_nearby_yard_min is null)
          or public._has_nearby_geo_range(v.lat, v.lng, 'yard_sign', f_nearby_yard_min, f_nearby_yard)
        )
        and (
          (f_nearby_vol is null and f_nearby_vol_min is null)
          or public._has_nearby_geo_range(v.lat, v.lng, 'volunteer', f_nearby_vol_min, f_nearby_vol)
        )
        and (
          not (f ? 'any_of')
          or jsonb_typeof(f->'any_of') <> 'array'
          or jsonb_array_length(f->'any_of') = 0
          or public._voter_matches_any_of(v, f->'any_of')
        )
      order by v.id
      limit safe_limit
    ) t;
  end if;

  return jsonb_build_object(
    'points', coalesce(rows_json, '[]'::jsonb),
    'returned', jsonb_array_length(coalesce(rows_json, '[]'::jsonb)),
    'total_with_coords', coalesce(total_with_coords, 0),
    'truncated', coalesce(total_with_coords, 0) > safe_limit
  );
end;
$$;

revoke all on function public.voter_map_points(jsonb, int) from public;
grant execute on function public.voter_map_points(jsonb, int) to service_role;

-- Add states to filter options (wrap existing by redefining with states).
create or replace function public.voter_filter_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform set_config('statement_timeout', '30s', true);
  return jsonb_build_object(
    'counties', coalesce((select jsonb_agg(x order by x) from (
      select distinct county as x from public.voters where county is not null and county <> '' limit 500
    ) s), '[]'::jsonb),
    'parties', coalesce((select jsonb_agg(x order by x) from (
      select distinct party as x from public.voters where party is not null and party <> '' limit 100
    ) s), '[]'::jsonb),
    'statuses', coalesce((select jsonb_agg(x order by x) from (
      select distinct status as x from public.voters where status is not null and status <> '' limit 50
    ) s), '[]'::jsonb),
    'states', coalesce((select jsonb_agg(x order by x) from (
      select distinct upper(state) as x from public.voters where state is not null and state <> '' limit 60
    ) s), '[]'::jsonb),
    'cities', coalesce((select jsonb_agg(x order by x) from (
      select distinct city as x from public.voters where city is not null and city <> '' limit 500
    ) s), '[]'::jsonb),
    'alignment_labels', coalesce((select jsonb_agg(x order by x) from (
      select distinct alignment_label as x from public.voters where alignment_label is not null and alignment_label <> '' limit 50
    ) s), '[]'::jsonb),
    'yard_signs', coalesce((select jsonb_agg(x order by x) from (
      select distinct yard_sign as x from public.voters where yard_sign is not null and yard_sign <> '' limit 50
    ) s), '[]'::jsonb),
    'volunteer_interests', coalesce((select jsonb_agg(x order by x) from (
      select distinct volunteer_interest as x from public.voters where volunteer_interest is not null and volunteer_interest <> '' limit 50
    ) s), '[]'::jsonb),
    'newsletters', coalesce((select jsonb_agg(x order by x) from (
      select distinct newsletter as x from public.voters where newsletter is not null and newsletter <> '' limit 50
    ) s), '[]'::jsonb),
    'donated', coalesce((select jsonb_agg(x order by x) from (
      select distinct donated as x from public.voters where donated is not null and donated <> '' limit 50
    ) s), '[]'::jsonb),
    'attended_events', coalesce((select jsonb_agg(x order by x) from (
      select distinct attended_event as x from public.voters where attended_event is not null and attended_event <> '' limit 50
    ) s), '[]'::jsonb),
    'top_main_topics', coalesce((select jsonb_agg(x order by x) from (
      select distinct top_main_topic as x from public.voters where top_main_topic is not null and top_main_topic <> '' limit 100
    ) s), '[]'::jsonb),
    'convos_candidate_support', coalesce((select jsonb_agg(x order by x) from (
      select distinct convos_candidate_support as x from public.voters where convos_candidate_support is not null and convos_candidate_support <> '' limit 50
    ) s), '[]'::jsonb),
    'convos_contact_status', coalesce((select jsonb_agg(x order by x) from (
      select distinct convos_contact_status as x from public.voters where convos_contact_status is not null and convos_contact_status <> '' limit 50
    ) s), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.voter_filter_options() from public;
grant execute on function public.voter_filter_options() to service_role;


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
  ins_pii int := 0;
  upd_pii int := 0;
begin
  perform set_config('statement_timeout', '120s', true);

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
    src_ord int generated by default as identity,
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

  insert into _voter_import (
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


  -- Prevent voters_voter_id_key collisions before murmuration upserts.
  -- Keep first row per voter_id within the batch.
  update _voter_import i
  set voter_id = null
  from (
    select src_ord,
      row_number() over (partition by voter_id order by src_ord) as rn
    from _voter_import
    where murmuration_id is not null and voter_id is not null
  ) d
  where i.src_ord = d.src_ord and d.rn > 1;

  -- If voter_id already belongs to a different murmuration_id, don't steal it.
  update _voter_import i
  set voter_id = null
  where i.murmuration_id is not null
    and i.voter_id is not null
    and exists (
      select 1 from public.voters v
      where v.voter_id = i.voter_id
        and v.murmuration_id is distinct from i.murmuration_id
        and coalesce(v.murmuration_id, '') <> ''
    );

  -- Orphan rows (voter_id exists, no murmuration_id): attach incoming murmuration_id.
  update public.voters v
  set murmuration_id = i.murmuration_id,
      updated_at = now()
  from _voter_import i
  where i.murmuration_id is not null
    and i.voter_id is not null
    and v.voter_id = i.voter_id
    and (v.murmuration_id is null or v.murmuration_id = '')
    and not exists (
      select 1 from public.voters x
      where x.murmuration_id = i.murmuration_id
    );

  -- 1) Upsert rows that have murmuration_id
  with src as (
    select distinct on (murmuration_id) *
    from _voter_import
    where murmuration_id is not null
    order by murmuration_id, src_ord
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
      convos_poll_question, donated, attended_event, import_batch_id
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
      convos_poll_question, donated, attended_event, batch_id
    from src
    on conflict (murmuration_id) where murmuration_id is not null and murmuration_id <> ''
    do update set
      voter_id = case
        when excluded.voter_id is null then v.voter_id
        when excluded.voter_id is not distinct from v.voter_id then v.voter_id
        when exists (
          select 1 from public.voters o
          where o.voter_id = excluded.voter_id and o.id <> v.id
        ) then v.voter_id
        else excluded.voter_id
      end,
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
    order by voter_id, src_ord
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
      convos_poll_question, donated, attended_event, import_batch_id
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
      convos_poll_question, donated, attended_event, batch_id
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

  -- 3) ID-less rows: index-friendly email/phone match, then name+address
  if not exists (
    select 1 from _voter_import where murmuration_id is null and voter_id is null
  ) then
    skipped := 0;
  else
  drop table if exists _voter_pii;
  create temporary table _voter_pii on commit drop as
  select
    i.*,
    public._norm_email(i.email) as email_n,
    public._norm_phone(i.phone) as phone_n,
    public._phone_digits(i.phone) as phone_d,
    public._norm_name(
      trim(coalesce(i.first_name, '') || ' ' || coalesce(i.last_name, ''))
    ) as name_n,
    public._norm_address(i.address_line_1) as addr_n
  from _voter_import i
  where i.murmuration_id is null and i.voter_id is null;

  create index on _voter_pii (email_n) where email_n is not null;
  create index on _voter_pii (phone_d) where phone_d is not null;
  create index on _voter_pii (src_ord);

  drop table if exists _voter_pii_match;
  create temporary table _voter_pii_match (
    src_ord int primary key,
    match_id bigint not null
  ) on commit drop;

  -- Prefer lower(email) to hit voters_email_lower_idx
  insert into _voter_pii_match (src_ord, match_id)
  select distinct on (p.src_ord) p.src_ord, v.id
  from _voter_pii p
  join public.voters v on lower(v.email) = p.email_n
  where p.email_n is not null
  order by p.src_ord, v.id;

  -- Prefer _phone_digits to hit voters_phone_digits_idx
  insert into _voter_pii_match (src_ord, match_id)
  select distinct on (p.src_ord) p.src_ord, v.id
  from _voter_pii p
  join public.voters v on public._phone_digits(v.phone) = p.phone_d
  where p.phone_d is not null
    and length(p.phone_d) >= 7
    and not exists (select 1 from _voter_pii_match m where m.src_ord = p.src_ord)
  order by p.src_ord, v.id;

  -- Fallback: normalized phone (strips leading 1) when digits form differs
  insert into _voter_pii_match (src_ord, match_id)
  select distinct on (p.src_ord) p.src_ord, v.id
  from _voter_pii p
  join public.voters v on public._norm_phone(v.phone) = p.phone_n
  where p.phone_n is not null
    and length(p.phone_n) >= 7
    and not exists (select 1 from _voter_pii_match m where m.src_ord = p.src_ord)
  order by p.src_ord, v.id;

  insert into _voter_pii_match (src_ord, match_id)
  select distinct on (p.src_ord) p.src_ord, v.id
  from _voter_pii p
  join public.voters v
    on public._norm_name(
         trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, ''))
       ) = p.name_n
   and public._norm_address(v.address_line_1) = p.addr_n
  where p.name_n is not null
    and p.addr_n is not null
    and not exists (select 1 from _voter_pii_match m where m.src_ord = p.src_ord)
  order by p.src_ord, v.id;

  with src as (
    -- One incoming row per existing voter (last wins within batch)
    select distinct on (m.match_id) p.*, m.match_id
    from _voter_pii p
    join _voter_pii_match m on m.src_ord = p.src_ord
    order by m.match_id, p.src_ord desc
  ),
  updated_rows as (
    update public.voters v set
      first_name = coalesce(s.first_name, v.first_name),
      last_name = coalesce(s.last_name, v.last_name),
      email = coalesce(s.email, v.email),
      phone = coalesce(s.phone, v.phone),
      age = coalesce(s.age, v.age),
      address_line_1 = coalesce(s.address_line_1, v.address_line_1),
      city = coalesce(s.city, v.city),
      county = coalesce(s.county, v.county),
      zip = coalesce(s.zip, v.zip),
      state = coalesce(s.state, v.state),
      lat = coalesce(s.lat, v.lat),
      lng = coalesce(s.lng, v.lng),
      party = coalesce(s.party, v.party),
      voter_registered = coalesce(s.voter_registered, v.voter_registered),
      status = coalesce(s.status, v.status),
      sig_open_primaries = coalesce(s.sig_open_primaries, v.sig_open_primaries),
      sig_reproductive_freedom = coalesce(s.sig_reproductive_freedom, v.sig_reproductive_freedom),
      sig_achilles_petition = coalesce(s.sig_achilles_petition, v.sig_achilles_petition),
      sig_medical_cannabis = coalesce(s.sig_medical_cannabis, v.sig_medical_cannabis),
      sig_medical_marijuana_valid_code = coalesce(s.sig_medical_marijuana_valid_code, v.sig_medical_marijuana_valid_code),
      sig_reproductive_freedom_valid_code = coalesce(s.sig_reproductive_freedom_valid_code, v.sig_reproductive_freedom_valid_code),
      volunteer_interest = coalesce(s.volunteer_interest, v.volunteer_interest),
      yard_sign = coalesce(s.yard_sign, v.yard_sign),
      support_score = coalesce(s.support_score, v.support_score),
      newsletter = coalesce(s.newsletter, v.newsletter),
      legacy_volunteer = coalesce(s.legacy_volunteer, v.legacy_volunteer),
      alignment_score = coalesce(s.alignment_score, v.alignment_score),
      top_main_topic = coalesce(s.top_main_topic, v.top_main_topic),
      alignment_label = coalesce(s.alignment_label, v.alignment_label),
      contact_tags = coalesce(s.contact_tags, v.contact_tags),
      convos_candidate_support = coalesce(s.convos_candidate_support, v.convos_candidate_support),
      convos_contact_status = coalesce(s.convos_contact_status, v.convos_contact_status),
      convos_poll_question = coalesce(s.convos_poll_question, v.convos_poll_question),
      donated = coalesce(s.donated, v.donated),
      attended_event = coalesce(s.attended_event, v.attended_event),
      updated_at = now()
    from src s
    where v.id = s.match_id
    returning v.id
  )
  select count(*) into upd_pii from updated_rows;

  with to_insert as (
    select p.*
    from _voter_pii p
    where not exists (select 1 from _voter_pii_match m where m.src_ord = p.src_ord)
      and (
        p.email_n is not null
        or p.phone_n is not null
        or p.name_n is not null
        or p.first_name is not null
        or p.last_name is not null
        or p.address_line_1 is not null
        or p.city is not null
        or p.zip is not null
        or p.county is not null
      )
  ),
  inserted_rows as (
    insert into public.voters (
      first_name, last_name, email, phone, age,
      address_line_1, city, county, zip, state, lat, lng,
      party, voter_registered, status,
      sig_open_primaries, sig_reproductive_freedom, sig_achilles_petition,
      sig_medical_cannabis, sig_medical_marijuana_valid_code,
      sig_reproductive_freedom_valid_code,
      volunteer_interest, yard_sign, support_score, newsletter,
      legacy_volunteer, alignment_score, top_main_topic, alignment_label,
      contact_tags, convos_candidate_support, convos_contact_status,
      convos_poll_question, donated, attended_event, import_batch_id
    )
    select
      first_name, last_name, email, phone, age,
      address_line_1, city, county, zip, state, lat, lng,
      party, voter_registered, status,
      sig_open_primaries, sig_reproductive_freedom, sig_achilles_petition,
      sig_medical_cannabis, sig_medical_marijuana_valid_code,
      sig_reproductive_freedom_valid_code,
      volunteer_interest, yard_sign, support_score, newsletter,
      legacy_volunteer, alignment_score, top_main_topic, alignment_label,
      contact_tags, convos_candidate_support, convos_contact_status,
      convos_poll_question, donated, attended_event, batch_id
    from to_insert
    returning id
  )
  select count(*) into ins_pii from inserted_rows;

  -- Only count truly empty shells as skipped (everything else is inserted).
  select count(*) into skipped
  from _voter_pii p
  where not exists (select 1 from _voter_pii_match m where m.src_ord = p.src_ord)
    and p.email_n is null
    and p.phone_n is null
    and p.name_n is null
    and p.first_name is null
    and p.last_name is null
    and p.address_line_1 is null
    and p.city is null
    and p.zip is null
    and p.county is null;
  end if;

  inserted := coalesce(ins_mid, 0) + coalesce(ins_vid, 0) + coalesce(ins_pii, 0);
  updated := coalesce(upd_mid, 0) + coalesce(upd_vid, 0) + coalesce(upd_pii, 0);

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




-- Fast replace of lean geo pins (used when Search nearby-filters and table is empty).

create or replace function public.voter_search(
  filters jsonb default '{}'::jsonb,
  q text default '',
  page int default 1,
  page_size int default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  f jsonb := coalesce(filters, '{}'::jsonb);
  safe_page int := greatest(coalesce(page, 1), 1);
  safe_size int := least(greatest(coalesce(page_size, 50), 1), 100);
  offset_rows int;
  needle text := nullif(trim(coalesce(q, '')), '');
  f_county text[]; f_party text[]; f_city text[]; f_zip text[]; f_status text[]; f_state text[];
  x_county text[]; x_party text[]; x_city text[]; x_zip text[]; x_status text[]; x_state text[];
  f_age_min int; f_age_max int; f_support_min int; f_support_max int;
  x_age_min int; x_age_max int; x_support_min int; x_support_max int;
  f_has_coords boolean; f_signed text[]; x_signed text[];
  f_signed_any boolean; f_signed_all_core boolean;
  f_alignment text[]; f_yard text[]; f_volunteer text[]; f_newsletter text[];
  f_donated text[]; f_attended text[]; f_topic text[]; f_convos_support text[]; f_convos_status text[];
  x_alignment text[]; x_yard text[]; x_volunteer text[]; x_newsletter text[];
  x_donated text[]; x_attended text[]; x_topic text[]; x_convos_support text[]; x_convos_status text[];
  f_has_volunteer boolean; f_has_yard boolean; f_has_donated boolean;
  x_has_volunteer boolean; x_has_yard boolean; x_has_donated boolean;
  x_campaign_volunteer boolean;
  f_nearby_yard double precision; f_nearby_vol double precision;
  f_nearby_yard_min double precision; f_nearby_vol_min double precision;
  f_supporter_tag text[];
  f_any_of jsonb;
  need_open boolean; need_repro boolean; need_achilles boolean; need_mmj boolean;
  x_open boolean; x_repro boolean; x_achilles boolean; x_mmj boolean;
  has_filters boolean;
  display_miles double precision := 1.0;
  total_count bigint;
  rows_json jsonb;
begin
  perform set_config('statement_timeout', '60s', true);
  offset_rows := (safe_page - 1) * safe_size;

  f_county := public._lower_text_array(public._jsonb_text_array(f, 'county'));
  f_party := public._lower_text_array(public._jsonb_text_array(f, 'party'));
  f_city := public._lower_text_array(public._jsonb_text_array(f, 'city'));
  f_zip := public._jsonb_text_array(f, 'zip');
  f_status := public._lower_text_array(public._jsonb_text_array(f, 'status'));
  f_state := public._lower_text_array(public._jsonb_text_array(f, 'state'));
  x_county := public._lower_text_array(public._jsonb_text_array(f, 'exclude_county'));
  x_party := public._lower_text_array(public._jsonb_text_array(f, 'exclude_party'));
  x_city := public._lower_text_array(public._jsonb_text_array(f, 'exclude_city'));
  x_zip := public._jsonb_text_array(f, 'exclude_zip');
  x_status := public._lower_text_array(public._jsonb_text_array(f, 'exclude_status'));
  x_state := public._lower_text_array(public._jsonb_text_array(f, 'exclude_state'));
  f_age_min := nullif(f->>'age_min', '')::int;
  f_age_max := nullif(f->>'age_max', '')::int;
  f_support_min := nullif(f->>'support_score_min', '')::int;
  f_support_max := nullif(f->>'support_score_max', '')::int;
  x_age_min := nullif(f->>'exclude_age_min', '')::int;
  x_age_max := nullif(f->>'exclude_age_max', '')::int;
  x_support_min := nullif(f->>'exclude_support_score_min', '')::int;
  x_support_max := nullif(f->>'exclude_support_score_max', '')::int;
  f_has_coords := nullif(f->>'has_coords', '')::boolean;
  f_signed := public._jsonb_text_array(f, 'signed');
  x_signed := public._jsonb_text_array(f, 'exclude_signed');
  f_signed_any := nullif(f->>'signed_any', '')::boolean;
  f_signed_all_core := nullif(f->>'signed_all_core', '')::boolean;
  f_alignment := public._lower_text_array(public._jsonb_text_array(f, 'alignment_label'));
  f_yard := public._lower_text_array(public._jsonb_text_array(f, 'yard_sign'));
  f_volunteer := public._lower_text_array(public._jsonb_text_array(f, 'volunteer_interest'));
  f_newsletter := public._lower_text_array(public._jsonb_text_array(f, 'newsletter'));
  f_donated := public._lower_text_array(public._jsonb_text_array(f, 'donated'));
  f_attended := public._lower_text_array(public._jsonb_text_array(f, 'attended_event'));
  f_topic := public._lower_text_array(public._jsonb_text_array(f, 'top_main_topic'));
  f_convos_support := public._lower_text_array(public._jsonb_text_array(f, 'convos_candidate_support'));
  f_convos_status := public._lower_text_array(public._jsonb_text_array(f, 'convos_contact_status'));
  x_alignment := public._lower_text_array(public._jsonb_text_array(f, 'exclude_alignment_label'));
  x_yard := public._lower_text_array(public._jsonb_text_array(f, 'exclude_yard_sign'));
  x_volunteer := public._lower_text_array(public._jsonb_text_array(f, 'exclude_volunteer_interest'));
  x_newsletter := public._lower_text_array(public._jsonb_text_array(f, 'exclude_newsletter'));
  x_donated := public._lower_text_array(public._jsonb_text_array(f, 'exclude_donated'));
  x_attended := public._lower_text_array(public._jsonb_text_array(f, 'exclude_attended_event'));
  x_topic := public._lower_text_array(public._jsonb_text_array(f, 'exclude_top_main_topic'));
  x_convos_support := public._lower_text_array(public._jsonb_text_array(f, 'exclude_convos_candidate_support'));
  x_convos_status := public._lower_text_array(public._jsonb_text_array(f, 'exclude_convos_contact_status'));
  f_has_volunteer := nullif(f->>'has_volunteer', '')::boolean;
  f_has_yard := nullif(f->>'has_yard_sign', '')::boolean;
  f_has_donated := nullif(f->>'has_donated', '')::boolean;
  x_has_volunteer := nullif(f->>'exclude_has_volunteer', '')::boolean;
  x_has_yard := nullif(f->>'exclude_has_yard_sign', '')::boolean;
  x_has_donated := nullif(f->>'exclude_has_donated', '')::boolean;
  x_campaign_volunteer := nullif(f->>'exclude_campaign_volunteer', '')::boolean;
  f_nearby_yard := coalesce(
    nullif(f->>'nearby_yard_sign_max_miles', '')::double precision,
    nullif(f->>'nearby_yard_sign_miles', '')::double precision
  );
  f_nearby_vol := coalesce(
    nullif(f->>'nearby_volunteer_max_miles', '')::double precision,
    nullif(f->>'nearby_volunteer_miles', '')::double precision
  );
  f_nearby_yard_min := nullif(f->>'nearby_yard_sign_min_miles', '')::double precision;
  f_nearby_vol_min := nullif(f->>'nearby_volunteer_min_miles', '')::double precision;
  f_supporter_tag := public._lower_text_array(public._jsonb_text_array(f, 'supporter_tag'));
  f_any_of := f->'any_of';
  need_open := f_signed is not null and 'open_primaries' = any (f_signed);
  need_repro := f_signed is not null and 'reproductive_freedom' = any (f_signed);
  need_achilles := f_signed is not null and 'achilles' = any (f_signed);
  need_mmj := f_signed is not null and 'medical_marijuana_valid' = any (f_signed);
  x_open := x_signed is not null and 'open_primaries' = any (x_signed);
  x_repro := x_signed is not null and 'reproductive_freedom' = any (x_signed);
  x_achilles := x_signed is not null and 'achilles' = any (x_signed);
  x_mmj := x_signed is not null and 'medical_marijuana_valid' = any (x_signed);

  if f_nearby_yard is not null then
    display_miles := greatest(display_miles, f_nearby_yard);
  elsif f_nearby_yard_min is not null then
    display_miles := greatest(display_miles, greatest(f_nearby_yard_min * 2, 5));
  end if;
  if f_nearby_vol is not null then
    display_miles := greatest(display_miles, f_nearby_vol);
  elsif f_nearby_vol_min is not null then
    display_miles := greatest(display_miles, greatest(f_nearby_vol_min * 2, 5));
  end if;

  has_filters :=
    f_county is not null or f_party is not null or f_city is not null or f_zip is not null or f_status is not null or f_state is not null
    or x_county is not null or x_party is not null or x_city is not null or x_zip is not null or x_status is not null or x_state is not null
    or f_age_min is not null or f_age_max is not null or f_support_min is not null or f_support_max is not null
    or x_age_min is not null or x_age_max is not null or x_support_min is not null or x_support_max is not null
    or f_has_coords is not null or f_signed is not null or x_signed is not null
    or f_signed_any is not null or f_signed_all_core is not null
    or f_alignment is not null or f_yard is not null or f_volunteer is not null or f_newsletter is not null
    or f_donated is not null or f_attended is not null or f_topic is not null
    or f_convos_support is not null or f_convos_status is not null
    or x_alignment is not null or x_yard is not null or x_volunteer is not null or x_newsletter is not null
    or x_donated is not null or x_attended is not null or x_topic is not null
    or x_convos_support is not null or x_convos_status is not null
    or f_has_volunteer is not null or f_has_yard is not null or f_has_donated is not null
    or x_has_volunteer is not null or x_has_yard is not null or x_has_donated is not null
    or x_campaign_volunteer is not null
    or f_nearby_yard is not null or f_nearby_vol is not null
    or f_nearby_yard_min is not null or f_nearby_vol_min is not null
    or f_state is not null or x_state is not null
    or f_supporter_tag is not null
    or (
      f_any_of is not null
      and jsonb_typeof(f_any_of) = 'array'
      and jsonb_array_length(f_any_of) > 0
    );

  -- Fast path: no text query, no filters — avoid per-row matcher + window count.
  if needle is null and not has_filters then
    select count(*) into total_count from public.voters;
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'murmuration_id', t.murmuration_id,
          'voter_id', t.voter_id,
          'first_name', t.first_name,
          'last_name', t.last_name,
          'email', t.email,
          'phone', t.phone,
          'address_line_1', t.address_line_1,
          'city', t.city,
          'state', t.state,
          'zip', t.zip,
          'county', t.county,
          'party', t.party,
          'age', t.age,
          'status', t.status,
          'support_score', t.support_score,
          'lat', t.lat,
          'lng', t.lng,
          'supporter_tag', t.supporter_tag,
          'is_campaign_volunteer', t.is_campaign_volunteer,
          'campaign_person_id', t.campaign_person_id,
          'nearby_yard_sign_miles', public._nearest_geo_miles(t.lat, t.lng, 'yard_sign', display_miles),
          'nearby_volunteer_miles', public._nearest_geo_miles(t.lat, t.lng, 'volunteer', display_miles)
        )
        order by t.last_name nulls last, t.first_name nulls last, t.id
      ),
      '[]'::jsonb
    )
    into rows_json
    from (
      select
        id, murmuration_id, voter_id, first_name, last_name, email, phone,
        address_line_1, city, state, zip, county, party, age, status, support_score,
        lat, lng, supporter_tag, is_campaign_volunteer, campaign_person_id
      from public.voters
      order by last_name nulls last, first_name nulls last, id
      offset offset_rows limit safe_size
    ) t;
    return jsonb_build_object(
      'rows', coalesce(rows_json, '[]'::jsonb),
      'total', total_count,
      'page', safe_page,
      'page_size', safe_size
    );
  end if;

  with matched as (
    select
      v.id, v.murmuration_id, v.voter_id, v.first_name, v.last_name, v.email, v.phone,
      v.address_line_1, v.city, v.state, v.zip, v.county, v.party, v.age, v.status,
      v.support_score, v.lat, v.lng,
      v.supporter_tag, v.is_campaign_volunteer, v.campaign_person_id,
      count(*) over() as full_count
    from public.voters v
    where
      (
        f_any_of is null
        or jsonb_typeof(f_any_of) <> 'array'
        or jsonb_array_length(f_any_of) = 0
        or public._voter_matches_any_of(v, f_any_of)
      )
      and public._arr_match(v.county, f_county, false)
      and public._arr_match(v.party, f_party, false)
      and public._arr_match(v.city, f_city, false)
      and (f_zip is null or v.zip = any (f_zip))
      and public._arr_match(v.status, f_status, false)
      and public._arr_match(v.state, f_state, false)
      and public._arr_match(v.county, x_county, true)
      and public._arr_match(v.party, x_party, true)
      and public._arr_match(v.city, x_city, true)
      and (x_zip is null or not (v.zip = any (x_zip)))
      and public._arr_match(v.status, x_status, true)
      and public._arr_match(v.state, x_state, true)
      and (
        f_age_min is null
        or coalesce(
          v.age,
          case when v.birth_year is not null
            then extract(year from current_date)::int - v.birth_year
          end
        ) >= f_age_min
      )
      and (
        f_age_max is null
        or coalesce(
          v.age,
          case when v.birth_year is not null
            then extract(year from current_date)::int - v.birth_year
          end
        ) <= f_age_max
      )
      and (f_support_min is null or (v.support_score is not null and v.support_score >= f_support_min))
      and (f_support_max is null or (v.support_score is not null and v.support_score <= f_support_max))
      and (
        (x_age_min is null and x_age_max is null)
        or coalesce(
          v.age,
          case when v.birth_year is not null
            then extract(year from current_date)::int - v.birth_year
          end
        ) is null
        or not (
          (
            x_age_min is null
            or coalesce(
              v.age,
              case when v.birth_year is not null
                then extract(year from current_date)::int - v.birth_year
              end
            ) >= x_age_min
          )
          and (
            x_age_max is null
            or coalesce(
              v.age,
              case when v.birth_year is not null
                then extract(year from current_date)::int - v.birth_year
              end
            ) <= x_age_max
          )
        )
      )
      and (
        (x_support_min is null and x_support_max is null)
        or v.support_score is null
        or not (
          (x_support_min is null or v.support_score >= x_support_min)
          and (x_support_max is null or v.support_score <= x_support_max)
        )
      )
      and (f_has_coords is null or not f_has_coords or (v.lat is not null and v.lng is not null))
      and (not need_open or public._is_signed(v.sig_open_primaries))
      and (not need_repro or public._has_reproductive_freedom(v))
      and (not need_achilles or public._is_signed(v.sig_achilles_petition))
      and (not need_mmj or public._is_signed(v.sig_medical_marijuana_valid_code))
      and (not x_open or not public._is_signed(v.sig_open_primaries))
      and (not x_repro or not public._has_reproductive_freedom(v))
      and (not x_achilles or not public._is_signed(v.sig_achilles_petition))
      and (not x_mmj or not public._is_signed(v.sig_medical_marijuana_valid_code))
      and (
        f_signed_any is null
        or not f_signed_any
        or public._is_signed(v.sig_open_primaries)
        or public._has_reproductive_freedom(v)
        or public._is_signed(v.sig_achilles_petition)
        or public._is_signed(v.sig_medical_marijuana_valid_code)
      )
      and (
        f_signed_all_core is null
        or not f_signed_all_core
        or (
          public._is_signed(v.sig_open_primaries)
          and public._has_reproductive_freedom(v)
          and public._is_signed(v.sig_achilles_petition)
        )
      )
      and public._arr_match(v.alignment_label, f_alignment, false)
      and public._arr_match(v.yard_sign, f_yard, false)
      and public._arr_match(v.volunteer_interest, f_volunteer, false)
      and public._arr_match(v.newsletter, f_newsletter, false)
      and public._arr_match(v.donated, f_donated, false)
      and public._arr_match(v.attended_event, f_attended, false)
      and public._arr_match(v.top_main_topic, f_topic, false)
      and public._arr_match(v.convos_candidate_support, f_convos_support, false)
      and public._arr_match(v.convos_contact_status, f_convos_status, false)
      and public._arr_match(v.alignment_label, x_alignment, true)
      and public._arr_match(v.yard_sign, x_yard, true)
      and public._arr_match(v.volunteer_interest, x_volunteer, true)
      and public._arr_match(v.newsletter, x_newsletter, true)
      and public._arr_match(v.donated, x_donated, true)
      and public._arr_match(v.attended_event, x_attended, true)
      and public._arr_match(v.top_main_topic, x_topic, true)
      and public._arr_match(v.convos_candidate_support, x_convos_support, true)
      and public._arr_match(v.convos_contact_status, x_convos_status, true)
      and (f_has_volunteer is null or not f_has_volunteer or public._is_truthy_yes(v.volunteer_interest))
      and (f_has_yard is null or not f_has_yard or public._is_truthy_yes(v.yard_sign))
      and (f_has_donated is null or not f_has_donated or public._is_truthy_yes(v.donated))
      and (x_has_volunteer is null or not x_has_volunteer or not public._is_truthy_yes(v.volunteer_interest))
      and (x_has_yard is null or not x_has_yard or not public._is_truthy_yes(v.yard_sign))
      and (x_has_donated is null or not x_has_donated or not public._is_truthy_yes(v.donated))
      and (x_campaign_volunteer is null or not x_campaign_volunteer or not v.is_campaign_volunteer)
      and (
        (f_nearby_yard is null and f_nearby_yard_min is null)
        or public._has_nearby_geo_range(v.lat, v.lng, 'yard_sign', f_nearby_yard_min, f_nearby_yard)
      )
      and (
        (f_nearby_vol is null and f_nearby_vol_min is null)
        or public._has_nearby_geo_range(v.lat, v.lng, 'volunteer', f_nearby_vol_min, f_nearby_vol)
      )
      and (
        f_supporter_tag is null
        or lower(coalesce(v.supporter_tag, '')) = any (f_supporter_tag)
      )
      and (
        needle is null
        or v.murmuration_id ilike '%'||needle||'%'
        or v.voter_id ilike '%'||needle||'%'
        or v.first_name ilike '%'||needle||'%'
        or v.last_name ilike '%'||needle||'%'
        or (coalesce(v.first_name,'')||' '||coalesce(v.last_name,'')) ilike '%'||needle||'%'
        or v.address_line_1 ilike '%'||needle||'%'
        or v.city ilike '%'||needle||'%'
        or v.zip ilike '%'||needle||'%'
        or v.email ilike '%'||needle||'%'
        or v.phone ilike '%'||needle||'%'
      )
    order by v.last_name nulls last, v.first_name nulls last, v.id
    offset offset_rows limit safe_size
  )
  select
    coalesce(max(full_count), 0),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', id,
          'murmuration_id', murmuration_id,
          'voter_id', voter_id,
          'first_name', first_name,
          'last_name', last_name,
          'email', email,
          'phone', phone,
          'address_line_1', address_line_1,
          'city', city,
          'state', state,
          'zip', zip,
          'county', county,
          'party', party,
          'age', age,
          'status', status,
          'support_score', support_score,
          'lat', lat,
          'lng', lng,
          'supporter_tag', supporter_tag,
          'is_campaign_volunteer', is_campaign_volunteer,
          'campaign_person_id', campaign_person_id,
          'nearby_yard_sign_miles', public._nearest_geo_miles(lat, lng, 'yard_sign', display_miles),
          'nearby_volunteer_miles', public._nearest_geo_miles(lat, lng, 'volunteer', display_miles)
        )
        order by last_name nulls last, first_name nulls last, id
      ),
      '[]'::jsonb
    )
  into total_count, rows_json
  from matched;

  return jsonb_build_object(
    'rows', coalesce(rows_json, '[]'::jsonb),
    'total', coalesce(total_count, 0),
    'page', safe_page,
    'page_size', safe_size
  );
end;
$$;


revoke all on function public.voter_search(jsonb, text, int, int) from public;
grant execute on function public.voter_search(jsonb, text, int, int) to service_role;

