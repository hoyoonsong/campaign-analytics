-- Fix apply_campaign_lean_sync under pg_safeupdate:
-- unqualified UPDATE voters is rejected ("UPDATE requires a WHERE clause"),
-- so lean sync never completed and geo contact columns stayed null.

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

  -- Must include a WHERE for pg_safeupdate; only clear rows that need clearing.
  update public.voters
  set is_campaign_volunteer = false,
      campaign_person_id = null
  where is_campaign_volunteer
     or campaign_person_id is not null;

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
