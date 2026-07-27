-- Speed: cache unfiltered analytics; store FormHandler contact on geo pins.

alter table public.campaign_sync_state
  add column if not exists analytics_summary_cache jsonb,
  add column if not exists analytics_summary_cached_at timestamptz;

alter table public.campaign_geo_points
  add column if not exists name text,
  add column if not exists email text,
  add column if not exists phone text,
  add column if not exists address text;

-- ---------------------------------------------------------------------------
-- Geo replace with contact fields (used by search ensureLeanGeo path)
-- ---------------------------------------------------------------------------
create or replace function public.replace_campaign_geo(p_geo jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
begin
  perform set_config('statement_timeout', '60s', true);
  truncate public.campaign_geo_points;
  if p_geo is null or jsonb_typeof(p_geo) <> 'array' or jsonb_array_length(p_geo) = 0 then
    return jsonb_build_object('geo_count', 0);
  end if;

  insert into public.campaign_geo_points (source_id, kind, lat, lng, name, email, phone, address)
  select distinct on (kind, source_id)
    source_id, kind, lat, lng, name, email, phone, address
  from (
    select
      coalesce(nullif(trim(x.source_id), '')::uuid, gen_random_uuid()) as source_id,
      x.kind,
      x.lat,
      x.lng,
      nullif(trim(x.name), '') as name,
      nullif(lower(trim(x.email)), '') as email,
      nullif(trim(x.phone), '') as phone,
      nullif(trim(x.address), '') as address
    from jsonb_to_recordset(p_geo) as x(
      source_id text,
      kind text,
      lat double precision,
      lng double precision,
      name text,
      email text,
      phone text,
      address text
    )
    where x.kind in ('volunteer', 'yard_sign')
      and x.lat is not null
      and x.lng is not null
  ) s
  order by kind, source_id;

  get diagnostics n = row_count;
  return jsonb_build_object('geo_count', n);
end;
$$;

revoke all on function public.replace_campaign_geo(jsonb) from public;
grant execute on function public.replace_campaign_geo(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Lean sync: geo insert includes contact columns
-- ---------------------------------------------------------------------------
create or replace function public.apply_campaign_lean_sync(
  p_contacts jsonb,
  p_geo jsonb,
  p_volunteer_count int default 0,
  p_yard_sign_count int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_geo_count int := 0;
  v_matched int := 0;
begin
  perform set_config('statement_timeout', '120s', true);

  truncate public.campaign_person_contacts;
  truncate public.campaign_geo_points;

  insert into public.campaign_person_contacts (person_id, email, phone_digits, is_volunteer)
  select
    (c->>'person_id')::uuid,
    nullif(lower(trim(c->>'email')), ''),
    nullif(c->>'phone_digits', ''),
    coalesce((c->>'is_volunteer')::boolean, false)
  from jsonb_array_elements(coalesce(p_contacts, '[]'::jsonb)) c
  where c->>'person_id' is not null
    and (
      nullif(lower(trim(c->>'email')), '') is not null
      or nullif(c->>'phone_digits', '') is not null
    );

  insert into public.campaign_geo_points (source_id, kind, lat, lng, name, email, phone, address)
  select distinct on (kind, source_id)
    source_id, kind, lat, lng, name, email, phone, address
  from (
    select
      (g->>'source_id')::uuid as source_id,
      g->>'kind' as kind,
      (g->>'lat')::double precision as lat,
      (g->>'lng')::double precision as lng,
      nullif(trim(g->>'name'), '') as name,
      nullif(lower(trim(g->>'email')), '') as email,
      nullif(trim(g->>'phone'), '') as phone,
      nullif(trim(g->>'address'), '') as address
    from jsonb_array_elements(coalesce(p_geo, '[]'::jsonb)) g
    where g->>'source_id' is not null
      and g->>'kind' in ('volunteer', 'yard_sign')
      and g->>'lat' is not null
      and g->>'lng' is not null
  ) s
  order by kind, source_id;

  get diagnostics v_geo_count = row_count;

  update public.voters
  set is_campaign_volunteer = false,
      campaign_person_id = null;

  update public.voters v
  set
    campaign_person_id = ep.person_id,
    is_campaign_volunteer = ev.is_volunteer
  from (
    select distinct on (email) email, person_id
    from public.campaign_person_contacts
    where email is not null
    order by email, is_volunteer desc, person_id
  ) ep
  join (
    select email, bool_or(is_volunteer) as is_volunteer
    from public.campaign_person_contacts
    where email is not null
    group by email
  ) ev on ev.email = ep.email
  where v.email is not null
    and lower(v.email) = ep.email;

  update public.voters v
  set
    campaign_person_id = ep.person_id,
    is_campaign_volunteer = v.is_campaign_volunteer or ev.is_volunteer
  from (
    select distinct on (phone_digits) phone_digits, person_id
    from public.campaign_person_contacts
    where phone_digits is not null
    order by phone_digits, is_volunteer desc, person_id
  ) ep
  join (
    select phone_digits, bool_or(is_volunteer) as is_volunteer
    from public.campaign_person_contacts
    where phone_digits is not null
    group by phone_digits
  ) ev on ev.phone_digits = ep.phone_digits
  where v.campaign_person_id is null
    and v.phone is not null
    and public._phone_digits(v.phone) = ep.phone_digits;

  update public.voters v
  set is_campaign_volunteer = true
  from public.campaign_person_contacts c
  where not v.is_campaign_volunteer
    and c.is_volunteer
    and (
      (v.email is not null and c.email is not null and lower(v.email) = c.email)
      or (
        v.phone is not null
        and c.phone_digits is not null
        and public._phone_digits(v.phone) = c.phone_digits
      )
    );

  select count(*)::int into v_matched
  from public.voters
  where campaign_person_id is not null or is_campaign_volunteer;

  update public.campaign_sync_state set
    last_success_at = now(),
    volunteer_count = coalesce(p_volunteer_count, 0),
    yard_sign_count = coalesce(p_yard_sign_count, 0),
    matched_voter_count = v_matched,
    geo_point_count = v_geo_count,
    last_error = null,
    updated_at = now()
  where id = 1;

  return jsonb_build_object(
    'geo_point_count', v_geo_count,
    'matched_voter_count', v_matched,
    'contact_rows', (select count(*)::int from public.campaign_person_contacts)
  );
end;
$$;

revoke all on function public.apply_campaign_lean_sync(jsonb, jsonb, int, int) from public;
grant execute on function public.apply_campaign_lean_sync(jsonb, jsonb, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- Refresh presence averages + full unfiltered analytics snapshot
-- ---------------------------------------------------------------------------
create or replace function public.refresh_presence_cache()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  avg_json jsonb;
  summary_json jsonb;
  uni bigint;
begin
  perform set_config('statement_timeout', '180s', true);

  select count(*) into uni from public.voters;

  avg_json := public.voter_avg_nearby(
    jsonb_build_object('state', jsonb_build_array('ID')),
    2000
  );

  summary_json := public.voter_analytics_summary('{}'::jsonb);

  update public.campaign_sync_state set
    avg_nearby_yard_sign_miles = nullif(avg_json->>'avg_nearby_yard_sign_miles', '')::numeric,
    avg_nearby_volunteer_miles = nullif(avg_json->>'avg_nearby_volunteer_miles', '')::numeric,
    avg_nearby_sample_size = coalesce((avg_json->>'avg_nearby_sample_size')::int, 0),
    avg_nearby_scope = 'state:ID',
    avg_nearby_computed_at = now(),
    universe_total = uni,
    analytics_summary_cache = summary_json,
    analytics_summary_cached_at = now(),
    updated_at = now()
  where id = 1;

  return jsonb_build_object(
    'universe_total', uni,
    'avg', avg_json,
    'scope', 'state:ID',
    'analytics_cached', summary_json is not null,
    'analytics_total', summary_json->>'total'
  );
end;
$$;

revoke all on function public.refresh_presence_cache() from public;
grant execute on function public.refresh_presence_cache() to service_role;

-- Seed so Analytics home is instant after migrate.
select public.refresh_presence_cache();
