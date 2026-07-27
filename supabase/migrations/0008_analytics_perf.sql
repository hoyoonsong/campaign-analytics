-- Faster analytics: parse filters once, single table scan, higher local timeout.
-- Also speed up voters_match_filters (extract each array once per call).

create or replace function public.voters_match_filters(v public.voters, filters jsonb)
returns boolean
language sql
stable
as $$
  select coalesce((
    select
      (f.county is null or lower(coalesce(v.county, '')) = any (f.county))
      and (f.party is null or lower(coalesce(v.party, '')) = any (f.party))
      and (f.city is null or lower(coalesce(v.city, '')) = any (f.city))
      and (f.zip is null or v.zip = any (f.zip))
      and (f.status is null or lower(coalesce(v.status, '')) = any (f.status))
      and (
        f.age_min is null
        or coalesce(
          v.age,
          case when v.birth_year is not null
            then extract(year from current_date)::int - v.birth_year
          end
        ) >= f.age_min
      )
      and (
        f.age_max is null
        or coalesce(
          v.age,
          case when v.birth_year is not null
            then extract(year from current_date)::int - v.birth_year
          end
        ) <= f.age_max
      )
      and (
        f.support_score_min is null
        or (v.support_score is not null and v.support_score >= f.support_score_min)
      )
      and (
        f.support_score_max is null
        or (v.support_score is not null and v.support_score <= f.support_score_max)
      )
      and (
        f.has_coords is null
        or (not f.has_coords)
        or (v.lat is not null and v.lng is not null)
      )
    from (
      select
        case
          when c is null then null
          else array(select lower(x) from unnest(c) as x)
        end as county,
        case
          when p is null then null
          else array(select lower(x) from unnest(p) as x)
        end as party,
        case
          when ci is null then null
          else array(select lower(x) from unnest(ci) as x)
        end as city,
        z as zip,
        case
          when s is null then null
          else array(select lower(x) from unnest(s) as x)
        end as status,
        nullif(filters->>'age_min', '')::int as age_min,
        nullif(filters->>'age_max', '')::int as age_max,
        nullif(filters->>'support_score_min', '')::int as support_score_min,
        nullif(filters->>'support_score_max', '')::int as support_score_max,
        nullif(filters->>'has_coords', '')::boolean as has_coords
      from (
        select
          public._jsonb_text_array(filters, 'county') as c,
          public._jsonb_text_array(filters, 'party') as p,
          public._jsonb_text_array(filters, 'city') as ci,
          public._jsonb_text_array(filters, 'zip') as z,
          public._jsonb_text_array(filters, 'status') as s
      ) raw
    ) f
  ), true);
$$;

create or replace function public.voter_analytics_summary(filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  f jsonb := coalesce(filters, '{}'::jsonb);
  f_county text[];
  f_party text[];
  f_city text[];
  f_zip text[];
  f_status text[];
  f_age_min int;
  f_age_max int;
  f_support_min int;
  f_support_max int;
  f_has_coords boolean;
  result jsonb;
begin
  perform set_config('statement_timeout', '90s', true);

  f_county := case
    when public._jsonb_text_array(f, 'county') is null then null
    else array(select lower(x) from unnest(public._jsonb_text_array(f, 'county')) as x)
  end;
  f_party := case
    when public._jsonb_text_array(f, 'party') is null then null
    else array(select lower(x) from unnest(public._jsonb_text_array(f, 'party')) as x)
  end;
  f_city := case
    when public._jsonb_text_array(f, 'city') is null then null
    else array(select lower(x) from unnest(public._jsonb_text_array(f, 'city')) as x)
  end;
  f_zip := public._jsonb_text_array(f, 'zip');
  f_status := case
    when public._jsonb_text_array(f, 'status') is null then null
    else array(select lower(x) from unnest(public._jsonb_text_array(f, 'status')) as x)
  end;
  f_age_min := nullif(f->>'age_min', '')::int;
  f_age_max := nullif(f->>'age_max', '')::int;
  f_support_min := nullif(f->>'support_score_min', '')::int;
  f_support_max := nullif(f->>'support_score_max', '')::int;
  f_has_coords := nullif(f->>'has_coords', '')::boolean;

  with filtered as (
    select
      v.county,
      v.party,
      v.status,
      v.age,
      v.birth_year,
      v.lat,
      v.lng,
      (lower(trim(coalesce(v.sig_open_primaries, ''))) in ('true','t','yes','y','1','signed','x','valid')) as s_open,
      (lower(trim(coalesce(v.sig_reproductive_freedom, ''))) in ('true','t','yes','y','1','signed','x','valid')) as s_repro,
      (lower(trim(coalesce(v.sig_achilles_petition, ''))) in ('true','t','yes','y','1','signed','x','valid')) as s_achilles,
      (lower(trim(coalesce(v.sig_medical_cannabis, ''))) in ('true','t','yes','y','1','signed','x','valid')) as s_cannabis,
      (lower(trim(coalesce(v.sig_medical_marijuana_valid_code, ''))) in ('true','t','yes','y','1','signed','x','valid')) as s_mmj_code,
      (lower(trim(coalesce(v.sig_reproductive_freedom_valid_code, ''))) in ('true','t','yes','y','1','signed','x','valid')) as s_repro_code
    from public.voters v
    where
      (f_county is null or lower(coalesce(v.county, '')) = any (f_county))
      and (f_party is null or lower(coalesce(v.party, '')) = any (f_party))
      and (f_city is null or lower(coalesce(v.city, '')) = any (f_city))
      and (f_zip is null or v.zip = any (f_zip))
      and (f_status is null or lower(coalesce(v.status, '')) = any (f_status))
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
      and (f_has_coords is null or not f_has_coords or (v.lat is not null and v.lng is not null))
  ),
  agg as (
    select
      count(*)::bigint as total,
      count(*) filter (where lat is not null and lng is not null)::bigint as with_coords,
      count(*) filter (where s_open)::bigint as open_primaries,
      count(*) filter (where s_repro)::bigint as reproductive_freedom,
      count(*) filter (where s_achilles)::bigint as achilles_petition,
      count(*) filter (where s_cannabis)::bigint as medical_cannabis,
      count(*) filter (where s_mmj_code)::bigint as medical_marijuana_valid,
      count(*) filter (where s_repro_code)::bigint as reproductive_freedom_valid,
      count(*) filter (where s_open and s_repro and s_achilles)::bigint as signed_all_core,
      count(*) filter (where s_open and s_repro and s_achilles and s_cannabis)::bigint as signed_all_four,
      count(*) filter (where s_open or s_repro or s_achilles or s_cannabis)::bigint as signed_any
    from filtered
  ),
  by_county as (
    select coalesce(nullif(county, ''), '(blank)') as key, count(*)::bigint as count
    from filtered
    group by 1
    order by count desc, key
    limit 100
  ),
  by_party as (
    select coalesce(nullif(party, ''), '(blank)') as key, count(*)::bigint as count
    from filtered
    group by 1
    order by count desc, key
    limit 50
  ),
  by_status as (
    select coalesce(nullif(status, ''), '(blank)') as key, count(*)::bigint as count
    from filtered
    group by 1
    order by count desc, key
    limit 50
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
  by_petition_count as (
    select
      ((s_open::int) + (s_repro::int) + (s_achilles::int) + (s_cannabis::int))::text as key,
      count(*)::bigint as count
    from filtered
    group by 1
    order by 1
  )
  select jsonb_build_object(
    'total', a.total,
    'with_coords', a.with_coords,
    'by_county', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_county), '[]'::jsonb),
    'by_party', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_party), '[]'::jsonb),
    'by_status', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_status), '[]'::jsonb),
    'by_age', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_age), '[]'::jsonb),
    'signatures', jsonb_build_object(
      'open_primaries', a.open_primaries,
      'reproductive_freedom', a.reproductive_freedom,
      'achilles_petition', a.achilles_petition,
      'medical_cannabis', a.medical_cannabis,
      'medical_marijuana_valid', a.medical_marijuana_valid,
      'reproductive_freedom_valid', a.reproductive_freedom_valid,
      'signed_all_core', a.signed_all_core,
      'signed_all_four', a.signed_all_four,
      'signed_any', a.signed_any
    ),
    'by_signature', jsonb_build_array(
      jsonb_build_object('key', 'Open Primaries', 'count', a.open_primaries),
      jsonb_build_object('key', 'Reproductive Freedom', 'count', a.reproductive_freedom),
      jsonb_build_object('key', 'Achilles Petition', 'count', a.achilles_petition),
      jsonb_build_object('key', 'Medical Cannabis', 'count', a.medical_cannabis),
      jsonb_build_object('key', 'Medical Marijuana valid code', 'count', a.medical_marijuana_valid),
      jsonb_build_object('key', 'Reproductive Freedom valid code', 'count', a.reproductive_freedom_valid)
    ),
    'by_petition_count', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_petition_count), '[]'::jsonb)
  )
  into result
  from agg a;

  return result;
end;
$$;

revoke all on function public.voter_analytics_summary(jsonb) from public;
grant execute on function public.voter_analytics_summary(jsonb) to service_role;
