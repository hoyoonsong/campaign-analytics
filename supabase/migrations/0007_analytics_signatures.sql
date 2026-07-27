-- Fix empty filter arrays (treat [] as "no filter").
-- Case-insensitive text filters.
-- Signature / petition aggregates for analytics charts.

create or replace function public._jsonb_text_array(j jsonb, key text)
returns text[]
language sql
immutable
as $$
  select case
    when j is null or not (j ? key) or j->key is null or j->key = 'null'::jsonb then null
    when jsonb_typeof(j->key) = 'array' then nullif(array(
      select nullif(trim(t), '')
      from jsonb_array_elements_text(j->key) as t
      where nullif(trim(t), '') is not null
    ), '{}'::text[])
    when jsonb_typeof(j->key) = 'string' and nullif(trim(j->>key), '') is not null
      then array[trim(j->>key)]
    else null
  end;
$$;

create or replace function public._is_signed(val text)
returns boolean
language sql
immutable
as $$
  select lower(trim(coalesce(val, ''))) in (
    'true', 't', 'yes', 'y', '1', 'signed', 'x', 'valid'
  );
$$;

create or replace function public.voters_match_filters(v public.voters, filters jsonb)
returns boolean
language sql
stable
as $$
  select
    (
      public._jsonb_text_array(filters, 'county') is null
      or lower(coalesce(v.county, '')) = any (
        select lower(x) from unnest(public._jsonb_text_array(filters, 'county')) as x
      )
    )
    and (
      public._jsonb_text_array(filters, 'party') is null
      or lower(coalesce(v.party, '')) = any (
        select lower(x) from unnest(public._jsonb_text_array(filters, 'party')) as x
      )
    )
    and (
      public._jsonb_text_array(filters, 'city') is null
      or lower(coalesce(v.city, '')) = any (
        select lower(x) from unnest(public._jsonb_text_array(filters, 'city')) as x
      )
    )
    and (
      public._jsonb_text_array(filters, 'zip') is null
      or v.zip = any (public._jsonb_text_array(filters, 'zip'))
    )
    and (
      public._jsonb_text_array(filters, 'status') is null
      or lower(coalesce(v.status, '')) = any (
        select lower(x) from unnest(public._jsonb_text_array(filters, 'status')) as x
      )
    )
    and (
      (filters->>'age_min') is null
      or nullif(filters->>'age_min', '') is null
      or (
        coalesce(
          v.age,
          case when v.birth_year is not null
            then extract(year from current_date)::int - v.birth_year
          end
        ) >= (filters->>'age_min')::int
      )
    )
    and (
      (filters->>'age_max') is null
      or nullif(filters->>'age_max', '') is null
      or (
        coalesce(
          v.age,
          case when v.birth_year is not null
            then extract(year from current_date)::int - v.birth_year
          end
        ) <= (filters->>'age_max')::int
      )
    )
    and (
      (filters->>'support_score_min') is null
      or nullif(filters->>'support_score_min', '') is null
      or (v.support_score is not null and v.support_score >= (filters->>'support_score_min')::int)
    )
    and (
      (filters->>'support_score_max') is null
      or nullif(filters->>'support_score_max', '') is null
      or (v.support_score is not null and v.support_score <= (filters->>'support_score_max')::int)
    )
    and (
      (filters->>'has_coords') is null
      or nullif(filters->>'has_coords', '') is null
      or (
        case when (filters->>'has_coords')::boolean
          then v.lat is not null and v.lng is not null
          else true
        end
      )
    );
$$;

create or replace function public.voter_analytics_summary(filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  with filtered as (
    select
      v.*,
      public._is_signed(v.sig_open_primaries) as s_open,
      public._is_signed(v.sig_reproductive_freedom) as s_repro,
      public._is_signed(v.sig_achilles_petition) as s_achilles,
      public._is_signed(v.sig_medical_cannabis) as s_cannabis,
      public._is_signed(v.sig_medical_marijuana_valid_code) as s_mmj_code,
      public._is_signed(v.sig_reproductive_freedom_valid_code) as s_repro_code
    from public.voters v
    where public.voters_match_filters(v, coalesce(filters, '{}'::jsonb))
  ),
  totals as (
    select count(*)::bigint as total from filtered
  ),
  by_county as (
    select coalesce(nullif(county, ''), '(blank)') as key, count(*)::bigint as count
    from filtered
    group by 1
    order by count desc, key
  ),
  by_party as (
    select coalesce(nullif(party, ''), '(blank)') as key, count(*)::bigint as count
    from filtered
    group by 1
    order by count desc, key
  ),
  by_status as (
    select coalesce(nullif(status, ''), '(blank)') as key, count(*)::bigint as count
    from filtered
    group by 1
    order by count desc, key
  ),
  by_age as (
    select
      case
        when coalesce(age, case when birth_year is not null
          then extract(year from current_date)::int - birth_year end) is null then 'Unknown'
        when coalesce(age, extract(year from current_date)::int - birth_year) < 18 then 'Under 18'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 18 and 24 then '18–24'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 25 and 34 then '25–34'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 35 and 44 then '35–44'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 45 and 54 then '45–54'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 55 and 64 then '55–64'
        else '65+'
      end as key,
      count(*)::bigint as count
    from filtered
    group by 1
  ),
  with_coords as (
    select count(*)::bigint as n
    from filtered
    where lat is not null and lng is not null
  ),
  signatures as (
    select
      count(*) filter (where s_open)::bigint as open_primaries,
      count(*) filter (where s_repro)::bigint as reproductive_freedom,
      count(*) filter (where s_achilles)::bigint as achilles_petition,
      count(*) filter (where s_cannabis)::bigint as medical_cannabis,
      count(*) filter (where s_mmj_code)::bigint as medical_marijuana_valid,
      count(*) filter (where s_repro_code)::bigint as reproductive_freedom_valid,
      -- Core petition set used for "signed all" (cannabis often empty in exports)
      count(*) filter (where s_open and s_repro and s_achilles)::bigint as signed_all_core,
      count(*) filter (where s_open and s_repro and s_achilles and s_cannabis)::bigint as signed_all_four,
      count(*) filter (where s_open or s_repro or s_achilles or s_cannabis)::bigint as signed_any
    from filtered
  ),
  by_petition_count as (
    select
      (
        (s_open::int) + (s_repro::int) + (s_achilles::int) + (s_cannabis::int)
      )::text as key,
      count(*)::bigint as count
    from filtered
    group by 1
    order by 1
  ),
  by_signature as (
    select * from (
      values
        ('Open Primaries', (select open_primaries from signatures)),
        ('Reproductive Freedom', (select reproductive_freedom from signatures)),
        ('Achilles Petition', (select achilles_petition from signatures)),
        ('Medical Cannabis', (select medical_cannabis from signatures)),
        ('Medical Marijuana valid code', (select medical_marijuana_valid from signatures)),
        ('Reproductive Freedom valid code', (select reproductive_freedom_valid from signatures))
    ) as t(key, count)
  )
  select jsonb_build_object(
    'total', (select total from totals),
    'with_coords', (select n from with_coords),
    'by_county', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_county), '[]'::jsonb),
    'by_party', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_party), '[]'::jsonb),
    'by_status', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_status), '[]'::jsonb),
    'by_age', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_age), '[]'::jsonb),
    'signatures', (select to_jsonb(signatures) from signatures),
    'by_signature', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_signature), '[]'::jsonb),
    'by_petition_count', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_petition_count), '[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

-- Dedupe filter options on case-insensitive key (prefer Title Case-ish first value).
create or replace function public.voter_filter_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  with counties as (
    select distinct on (lower(county)) county as key
    from public.voters
    where nullif(trim(county), '') is not null
    order by lower(county), county
  ),
  parties as (
    select distinct on (lower(party)) party as key
    from public.voters
    where nullif(trim(party), '') is not null
    order by lower(party), party
  ),
  statuses as (
    select distinct on (lower(status)) status as key
    from public.voters
    where nullif(trim(status), '') is not null
    order by lower(status), status
  ),
  cities as (
    select distinct on (lower(city)) city as key
    from public.voters
    where nullif(trim(city), '') is not null
    order by lower(city), city
  )
  select jsonb_build_object(
    'counties', coalesce((select jsonb_agg(key order by key) from counties), '[]'::jsonb),
    'parties', coalesce((select jsonb_agg(key order by key) from parties), '[]'::jsonb),
    'statuses', coalesce((select jsonb_agg(key order by key) from statuses), '[]'::jsonb),
    'cities', coalesce((select jsonb_agg(key order by key) from cities), '[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

revoke all on function public._is_signed(text) from public;
grant execute on function public._is_signed(text) to service_role;
revoke all on function public.voter_analytics_summary(jsonb) from public;
grant execute on function public.voter_analytics_summary(jsonb) to service_role;
revoke all on function public.voter_filter_options() from public;
grant execute on function public.voter_filter_options() to service_role;
