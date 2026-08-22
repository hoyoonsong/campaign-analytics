-- FormHandler roles on voters + universe source.
-- Volunteers, donors, event attendees, yard signs, newsletters all count as supporters.

alter table public.campaign_person_contacts
  add column if not exists is_donor boolean not null default false,
  add column if not exists is_attendee boolean not null default false,
  add column if not exists is_yard_sign boolean not null default false,
  add column if not exists is_newsletter boolean not null default false;

alter table public.voters
  add column if not exists is_campaign_donor boolean not null default false,
  add column if not exists is_campaign_attendee boolean not null default false,
  add column if not exists is_campaign_yard_sign boolean not null default false,
  add column if not exists is_campaign_newsletter boolean not null default false;

alter table public.saved_voter_universes
  add column if not exists source text;

create or replace function public._any_of_yes(vals text[])
returns boolean
language sql
immutable
parallel safe
as $$
  select vals is not null and exists (
    select 1
    from unnest(vals) as x
    where lower(trim(x)) in ('yes', 'y', 'true', '1')
  );
$$;

create or replace function public._voter_matches_any_of(
  v public.voters,
  rules jsonb
)
returns boolean
language plpgsql
stable
as $$
declare
  r jsonb;
  field text;
  vals text[];
  nums int[];
begin
  if rules is null
     or jsonb_typeof(rules) <> 'array'
     or jsonb_array_length(rules) = 0 then
    return true;
  end if;

  for r in select value from jsonb_array_elements(rules) as t(value)
  loop
    field := lower(trim(coalesce(r->>'field', '')));

    if field = 'support_score' then
      begin
        nums := array(
          select (x)::int
          from jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) as x
          where nullif(trim(x), '') is not null
        );
      exception when others then
        nums := null;
      end;
      if nums is not null
         and cardinality(nums) > 0
         and v.support_score is not null
         and v.support_score = any (nums) then
        return true;
      end if;
      continue;
    end if;

    vals := public._lower_text_array(public._jsonb_text_array(r, 'values'));
    if vals is null or cardinality(vals) = 0 then
      continue;
    end if;

    if field = 'yard_sign' and lower(coalesce(v.yard_sign, '')) = any (vals) then
      return true;
    elsif field = 'donated' and lower(coalesce(v.donated, '')) = any (vals) then
      return true;
    elsif field = 'alignment_label' and lower(coalesce(v.alignment_label, '')) = any (vals) then
      return true;
    elsif field = 'volunteer_interest' and lower(coalesce(v.volunteer_interest, '')) = any (vals) then
      return true;
    elsif field = 'newsletter' and lower(coalesce(v.newsletter, '')) = any (vals) then
      return true;
    elsif field = 'attended_event' and lower(coalesce(v.attended_event, '')) = any (vals) then
      return true;
    elsif field = 'convos_candidate_support'
      and lower(coalesce(v.convos_candidate_support, '')) = any (vals) then
      return true;
    elsif field = 'convos_contact_status'
      and lower(coalesce(v.convos_contact_status, '')) = any (vals) then
      return true;
    elsif field = 'convos_poll_question'
      and lower(coalesce(v.convos_poll_question, '')) = any (vals) then
      return true;
    elsif field = 'top_main_topic' and lower(coalesce(v.top_main_topic, '')) = any (vals) then
      return true;
    elsif field = 'county' and lower(coalesce(v.county, '')) = any (vals) then
      return true;
    elsif field = 'party' and lower(coalesce(v.party, '')) = any (vals) then
      return true;
    elsif field = 'status' and lower(coalesce(v.status, '')) = any (vals) then
      return true;
    elsif field in ('campaign_volunteer', 'is_campaign_volunteer')
      and v.is_campaign_volunteer
      and public._any_of_yes(vals) then
      return true;
    elsif field in ('campaign_donor', 'is_campaign_donor')
      and v.is_campaign_donor
      and public._any_of_yes(vals) then
      return true;
    elsif field in ('campaign_attendee', 'is_campaign_attendee')
      and v.is_campaign_attendee
      and public._any_of_yes(vals) then
      return true;
    elsif field in ('campaign_yard_sign', 'is_campaign_yard_sign')
      and v.is_campaign_yard_sign
      and public._any_of_yes(vals) then
      return true;
    elsif field in ('campaign_newsletter', 'is_campaign_newsletter')
      and v.is_campaign_newsletter
      and public._any_of_yes(vals) then
      return true;
    end if;
  end loop;

  return false;
end;
$$;

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

  insert into public.campaign_person_contacts (
    person_id, email, phone_digits,
    is_volunteer, is_donor, is_attendee, is_yard_sign, is_newsletter
  )
  select
    (c->>'person_id')::uuid,
    nullif(lower(trim(c->>'email')), ''),
    nullif(c->>'phone_digits', ''),
    coalesce((c->>'is_volunteer')::boolean, false),
    coalesce((c->>'is_donor')::boolean, false),
    coalesce((c->>'is_attendee')::boolean, false),
    coalesce((c->>'is_yard_sign')::boolean, false),
    coalesce((c->>'is_newsletter')::boolean, false)
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
  set
    is_campaign_volunteer = false,
    is_campaign_donor = false,
    is_campaign_attendee = false,
    is_campaign_yard_sign = false,
    is_campaign_newsletter = false,
    campaign_person_id = null
  where is_campaign_volunteer
     or is_campaign_donor
     or is_campaign_attendee
     or is_campaign_yard_sign
     or is_campaign_newsletter
     or campaign_person_id is not null;

  -- Murmuration ID
  update public.voters v
  set
    campaign_person_id = m.person_id,
    is_campaign_volunteer = v.is_campaign_volunteer or m.is_volunteer,
    is_campaign_donor = v.is_campaign_donor or m.is_donor,
    is_campaign_attendee = v.is_campaign_attendee or m.is_attendee,
    is_campaign_yard_sign = v.is_campaign_yard_sign or m.is_yard_sign,
    is_campaign_newsletter = v.is_campaign_newsletter or m.is_newsletter
  from (
    select
      mid,
      (array_agg(person_id order by is_volunteer desc, person_id))[1] as person_id,
      bool_or(is_volunteer) as is_volunteer,
      bool_or(is_donor) as is_donor,
      bool_or(is_attendee) as is_attendee,
      bool_or(is_yard_sign) as is_yard_sign,
      bool_or(is_newsletter) as is_newsletter
    from (
      select
        nullif(trim(c->>'murmuration_id'), '') as mid,
        (c->>'person_id')::uuid as person_id,
        coalesce((c->>'is_volunteer')::boolean, false) as is_volunteer,
        coalesce((c->>'is_donor')::boolean, false) as is_donor,
        coalesce((c->>'is_attendee')::boolean, false) as is_attendee,
        coalesce((c->>'is_yard_sign')::boolean, false) as is_yard_sign,
        coalesce((c->>'is_newsletter')::boolean, false) as is_newsletter
      from jsonb_array_elements(coalesce(p_contacts, '[]'::jsonb)) c
      where c->>'person_id' is not null
    ) x
    where mid is not null
    group by mid
  ) m
  where v.murmuration_id is not null
    and trim(v.murmuration_id) = m.mid;

  -- Email (still unlinked)
  update public.voters v
  set
    campaign_person_id = ep.person_id,
    is_campaign_volunteer = ev.is_volunteer,
    is_campaign_donor = ev.is_donor,
    is_campaign_attendee = ev.is_attendee,
    is_campaign_yard_sign = ev.is_yard_sign,
    is_campaign_newsletter = ev.is_newsletter
  from (
    select distinct on (email) email, person_id
    from public.campaign_person_contacts
    where email is not null
    order by email, is_volunteer desc, person_id
  ) ep
  join (
    select
      email,
      bool_or(is_volunteer) as is_volunteer,
      bool_or(is_donor) as is_donor,
      bool_or(is_attendee) as is_attendee,
      bool_or(is_yard_sign) as is_yard_sign,
      bool_or(is_newsletter) as is_newsletter
    from public.campaign_person_contacts
    where email is not null
    group by email
  ) ev on ev.email = ep.email
  where v.campaign_person_id is null
    and v.email is not null
    and lower(v.email) = ep.email;

  -- Phone (still unlinked)
  update public.voters v
  set
    campaign_person_id = ep.person_id,
    is_campaign_volunteer = v.is_campaign_volunteer or ev.is_volunteer,
    is_campaign_donor = v.is_campaign_donor or ev.is_donor,
    is_campaign_attendee = v.is_campaign_attendee or ev.is_attendee,
    is_campaign_yard_sign = v.is_campaign_yard_sign or ev.is_yard_sign,
    is_campaign_newsletter = v.is_campaign_newsletter or ev.is_newsletter
  from (
    select distinct on (phone_digits) phone_digits, person_id
    from public.campaign_person_contacts
    where phone_digits is not null
    order by phone_digits, is_volunteer desc, person_id
  ) ep
  join (
    select
      phone_digits,
      bool_or(is_volunteer) as is_volunteer,
      bool_or(is_donor) as is_donor,
      bool_or(is_attendee) as is_attendee,
      bool_or(is_yard_sign) as is_yard_sign,
      bool_or(is_newsletter) as is_newsletter
    from public.campaign_person_contacts
    where phone_digits is not null
    group by phone_digits
  ) ev on ev.phone_digits = ep.phone_digits
  where v.campaign_person_id is null
    and v.phone is not null
    and public._phone_digits(v.phone) = ep.phone_digits;

  -- OR remaining roles onto anyone already linked / matching email or phone
  update public.voters v
  set
    is_campaign_volunteer = v.is_campaign_volunteer or c.is_volunteer,
    is_campaign_donor = v.is_campaign_donor or c.is_donor,
    is_campaign_attendee = v.is_campaign_attendee or c.is_attendee,
    is_campaign_yard_sign = v.is_campaign_yard_sign or c.is_yard_sign,
    is_campaign_newsletter = v.is_campaign_newsletter or c.is_newsletter
  from (
    select
      email,
      bool_or(is_volunteer) as is_volunteer,
      bool_or(is_donor) as is_donor,
      bool_or(is_attendee) as is_attendee,
      bool_or(is_yard_sign) as is_yard_sign,
      bool_or(is_newsletter) as is_newsletter
    from public.campaign_person_contacts
    where email is not null
    group by email
  ) c
  where v.email is not null
    and lower(v.email) = c.email
    and (
      not v.is_campaign_volunteer and c.is_volunteer
      or not v.is_campaign_donor and c.is_donor
      or not v.is_campaign_attendee and c.is_attendee
      or not v.is_campaign_yard_sign and c.is_yard_sign
      or not v.is_campaign_newsletter and c.is_newsletter
    );

  update public.voters v
  set
    is_campaign_volunteer = v.is_campaign_volunteer or c.is_volunteer,
    is_campaign_donor = v.is_campaign_donor or c.is_donor,
    is_campaign_attendee = v.is_campaign_attendee or c.is_attendee,
    is_campaign_yard_sign = v.is_campaign_yard_sign or c.is_yard_sign,
    is_campaign_newsletter = v.is_campaign_newsletter or c.is_newsletter
  from (
    select
      phone_digits,
      bool_or(is_volunteer) as is_volunteer,
      bool_or(is_donor) as is_donor,
      bool_or(is_attendee) as is_attendee,
      bool_or(is_yard_sign) as is_yard_sign,
      bool_or(is_newsletter) as is_newsletter
    from public.campaign_person_contacts
    where phone_digits is not null
    group by phone_digits
  ) c
  where v.phone is not null
    and public._phone_digits(v.phone) = c.phone_digits
    and (
      not v.is_campaign_volunteer and c.is_volunteer
      or not v.is_campaign_donor and c.is_donor
      or not v.is_campaign_attendee and c.is_attendee
      or not v.is_campaign_yard_sign and c.is_yard_sign
      or not v.is_campaign_newsletter and c.is_newsletter
    );

  select count(*)::int into v_matched
  from public.voters
  where campaign_person_id is not null
     or is_campaign_volunteer
     or is_campaign_donor
     or is_campaign_attendee
     or is_campaign_yard_sign
     or is_campaign_newsletter;

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

create or replace function public.recompute_supporter_tags()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '180s'
as $$
declare
  n_maybe int := 0;
  n_opposed int := 0;
  n_supporter int := 0;
begin
  update public.voters set supporter_tag = null where supporter_tag is not null;

  update public.voters v
  set supporter_tag = 'maybe'
  where
    lower(coalesce(v.alignment_label, '')) = 'neutral'
    or lower(coalesce(v.convos_candidate_support, '')) = 'maybe'
    or lower(coalesce(v.convos_poll_question, '')) = 'c) not sure'
    or v.support_score = 3;
  get diagnostics n_maybe = row_count;

  update public.voters v
  set supporter_tag = 'opposed'
  where
    lower(coalesce(v.convos_candidate_support, '')) = 'no'
    or lower(coalesce(v.alignment_label, '')) = 'negative'
    or v.support_score in (4, 5);
  get diagnostics n_opposed = row_count;

  update public.voters v
  set supporter_tag = 'supporter'
  where
    lower(coalesce(v.yard_sign, '')) in ('yes', 'delivered')
    or lower(coalesce(v.donated, '')) = 'yes'
    or lower(coalesce(v.alignment_label, '')) = 'positive'
    or v.support_score in (1, 2)
    or lower(coalesce(v.convos_candidate_support, '')) = 'yes'
    or lower(coalesce(v.volunteer_interest, '')) in ('yes', 'y')
    or lower(coalesce(v.attended_event, '')) in ('yes', 'y')
    or lower(coalesce(v.newsletter, '')) in ('yes', 'y')
    or v.is_campaign_volunteer
    or v.is_campaign_donor
    or v.is_campaign_attendee
    or v.is_campaign_yard_sign
    or v.is_campaign_newsletter;
  get diagnostics n_supporter = row_count;

  return jsonb_build_object(
    'maybe', n_maybe,
    'opposed', n_opposed,
    'supporter', n_supporter,
    'tagged_voters', (select count(*)::int from public.voters where supporter_tag is not null)
  );
end;
$$;

revoke all on function public._any_of_yes(text[]) from public;
revoke all on function public.apply_campaign_lean_sync(jsonb, jsonb, int, int) from public;
revoke all on function public.recompute_supporter_tags() from public;
grant execute on function public.apply_campaign_lean_sync(jsonb, jsonb, int, int) to service_role;
grant execute on function public.recompute_supporter_tags() to service_role;
