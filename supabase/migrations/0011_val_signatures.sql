-- PDI "VAL" = valid signature code (not True/Yes). Count VAL as signed.

create or replace function public._is_signed(val text)
returns boolean
language sql
immutable
as $$
  select lower(trim(coalesce(val, ''))) in (
    'true', 't', 'yes', 'y', '1', 'signed', 'x', 'valid', 'val'
  );
$$;

-- Refresh analytics so signed_any / petition counts include VAL code columns.
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
  f_signed text[];
  f_signed_any boolean;
  f_signed_all_core boolean;
  f_alignment text[];
  f_yard text[];
  f_volunteer text[];
  f_newsletter text[];
  f_donated text[];
  f_attended text[];
  f_topic text[];
  f_convos_support text[];
  f_convos_status text[];
  f_has_volunteer boolean;
  f_has_yard boolean;
  f_has_donated boolean;
  need_open boolean;
  need_repro boolean;
  need_achilles boolean;
  need_cannabis boolean;
  need_mmj boolean;
  need_repro_valid boolean;
  result jsonb;
begin
  perform set_config('statement_timeout', '90s', true);

  f_county := public._lower_text_array(public._jsonb_text_array(f, 'county'));
  f_party := public._lower_text_array(public._jsonb_text_array(f, 'party'));
  f_city := public._lower_text_array(public._jsonb_text_array(f, 'city'));
  f_zip := public._jsonb_text_array(f, 'zip');
  f_status := public._lower_text_array(public._jsonb_text_array(f, 'status'));
  f_age_min := nullif(f->>'age_min', '')::int;
  f_age_max := nullif(f->>'age_max', '')::int;
  f_support_min := nullif(f->>'support_score_min', '')::int;
  f_support_max := nullif(f->>'support_score_max', '')::int;
  f_has_coords := nullif(f->>'has_coords', '')::boolean;
  f_signed := public._jsonb_text_array(f, 'signed');
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
  f_has_volunteer := nullif(f->>'has_volunteer', '')::boolean;
  f_has_yard := nullif(f->>'has_yard_sign', '')::boolean;
  f_has_donated := nullif(f->>'has_donated', '')::boolean;

  need_open := f_signed is not null and 'open_primaries' = any (f_signed);
  need_repro := f_signed is not null and 'reproductive_freedom' = any (f_signed);
  need_achilles := f_signed is not null and 'achilles' = any (f_signed);
  need_cannabis := f_signed is not null and 'medical_cannabis' = any (f_signed);
  need_mmj := f_signed is not null and 'medical_marijuana_valid' = any (f_signed);
  need_repro_valid := f_signed is not null and 'reproductive_freedom_valid' = any (f_signed);

  with filtered as (
    select
      v.county,
      v.party,
      v.status,
      v.age,
      v.birth_year,
      v.lat,
      v.lng,
      public._is_signed(v.sig_open_primaries) as s_open,
      public._is_signed(v.sig_reproductive_freedom) as s_repro,
      public._is_signed(v.sig_achilles_petition) as s_achilles,
      public._is_signed(v.sig_medical_cannabis) as s_cannabis,
      public._is_signed(v.sig_medical_marijuana_valid_code) as s_mmj_code,
      public._is_signed(v.sig_reproductive_freedom_valid_code) as s_repro_code
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
      and (not need_open or public._is_signed(v.sig_open_primaries))
      and (not need_repro or public._is_signed(v.sig_reproductive_freedom))
      and (not need_achilles or public._is_signed(v.sig_achilles_petition))
      and (not need_cannabis or public._is_signed(v.sig_medical_cannabis))
      and (not need_mmj or public._is_signed(v.sig_medical_marijuana_valid_code))
      and (not need_repro_valid or public._is_signed(v.sig_reproductive_freedom_valid_code))
      and (
        f_signed_any is null or not f_signed_any
        or public._is_signed(v.sig_open_primaries)
        or public._is_signed(v.sig_reproductive_freedom)
        or public._is_signed(v.sig_achilles_petition)
        or public._is_signed(v.sig_medical_cannabis)
        or public._is_signed(v.sig_medical_marijuana_valid_code)
        or public._is_signed(v.sig_reproductive_freedom_valid_code)
      )
      and (
        f_signed_all_core is null or not f_signed_all_core
        or (
          public._is_signed(v.sig_open_primaries)
          and public._is_signed(v.sig_reproductive_freedom)
          and public._is_signed(v.sig_achilles_petition)
        )
      )
      and (f_alignment is null or lower(coalesce(v.alignment_label, '')) = any (f_alignment))
      and (f_yard is null or lower(coalesce(v.yard_sign, '')) = any (f_yard))
      and (f_volunteer is null or lower(coalesce(v.volunteer_interest, '')) = any (f_volunteer))
      and (f_newsletter is null or lower(coalesce(v.newsletter, '')) = any (f_newsletter))
      and (f_donated is null or lower(coalesce(v.donated, '')) = any (f_donated))
      and (f_attended is null or lower(coalesce(v.attended_event, '')) = any (f_attended))
      and (f_topic is null or lower(coalesce(v.top_main_topic, '')) = any (f_topic))
      and (f_convos_support is null or lower(coalesce(v.convos_candidate_support, '')) = any (f_convos_support))
      and (f_convos_status is null or lower(coalesce(v.convos_contact_status, '')) = any (f_convos_status))
      and (f_has_volunteer is null or not f_has_volunteer or public._is_truthy_yes(v.volunteer_interest))
      and (f_has_yard is null or not f_has_yard or public._is_truthy_yes(v.yard_sign))
      and (f_has_donated is null or not f_has_donated or public._is_truthy_yes(v.donated))
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
      count(*) filter (where s_open and s_repro and s_achilles and (s_cannabis or s_mmj_code))::bigint as signed_all_four,
      count(*) filter (
        where s_open or s_repro or s_achilles or s_cannabis or s_mmj_code or s_repro_code
      )::bigint as signed_any
    from filtered
  ),
  by_county as (
    select coalesce(nullif(county, ''), '(blank)') as key, count(*)::bigint as count
    from filtered group by 1 order by count desc, key limit 100
  ),
  by_party as (
    select coalesce(nullif(party, ''), '(blank)') as key, count(*)::bigint as count
    from filtered group by 1 order by count desc, key limit 50
  ),
  by_status as (
    select coalesce(nullif(status, ''), '(blank)') as key, count(*)::bigint as count
    from filtered group by 1 order by count desc, key limit 50
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
  -- Count True petitions + VAL codes as signature marks (0–6).
  by_petition_count as (
    select
      (
        (s_open::int) + (s_repro::int) + (s_achilles::int) + (s_cannabis::int)
        + (s_mmj_code::int) + (s_repro_code::int)
      )::text as key,
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
      jsonb_build_object('key', 'Medical Marijuana (VAL)', 'count', a.medical_marijuana_valid),
      jsonb_build_object('key', 'Reproductive Freedom Act (VAL)', 'count', a.reproductive_freedom_valid),
      jsonb_build_object('key', 'Medical Cannabis (True)', 'count', a.medical_cannabis)
    ),
    'by_petition_count', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_petition_count), '[]'::jsonb)
  )
  into result
  from agg a;

  return result;
end;
$$;

-- Keep search/match helpers using the updated _is_signed (already referenced).
-- Also treat VAL in signed_any for search filters.
create or replace function public._voter_matches_locals(
  v public.voters,
  f_county text[],
  f_party text[],
  f_city text[],
  f_zip text[],
  f_status text[],
  f_age_min int,
  f_age_max int,
  f_support_min int,
  f_support_max int,
  f_has_coords boolean,
  f_signed text[],
  f_signed_any boolean,
  f_signed_all_core boolean,
  f_alignment text[],
  f_yard text[],
  f_volunteer text[],
  f_newsletter text[],
  f_donated text[],
  f_attended text[],
  f_topic text[],
  f_convos_support text[],
  f_convos_status text[],
  f_has_volunteer boolean,
  f_has_yard boolean,
  f_has_donated boolean
)
returns boolean
language sql
stable
as $$
  select
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
    and (f_signed is null or not ('open_primaries' = any (f_signed)) or public._is_signed(v.sig_open_primaries))
    and (f_signed is null or not ('reproductive_freedom' = any (f_signed)) or public._is_signed(v.sig_reproductive_freedom))
    and (f_signed is null or not ('achilles' = any (f_signed)) or public._is_signed(v.sig_achilles_petition))
    and (f_signed is null or not ('medical_cannabis' = any (f_signed)) or public._is_signed(v.sig_medical_cannabis))
    and (f_signed is null or not ('medical_marijuana_valid' = any (f_signed)) or public._is_signed(v.sig_medical_marijuana_valid_code))
    and (f_signed is null or not ('reproductive_freedom_valid' = any (f_signed)) or public._is_signed(v.sig_reproductive_freedom_valid_code))
    and (
      f_signed_any is null or not f_signed_any
      or public._is_signed(v.sig_open_primaries)
      or public._is_signed(v.sig_reproductive_freedom)
      or public._is_signed(v.sig_achilles_petition)
      or public._is_signed(v.sig_medical_cannabis)
      or public._is_signed(v.sig_medical_marijuana_valid_code)
      or public._is_signed(v.sig_reproductive_freedom_valid_code)
    )
    and (
      f_signed_all_core is null or not f_signed_all_core
      or (
        public._is_signed(v.sig_open_primaries)
        and public._is_signed(v.sig_reproductive_freedom)
        and public._is_signed(v.sig_achilles_petition)
      )
    )
    and (f_alignment is null or lower(coalesce(v.alignment_label, '')) = any (f_alignment))
    and (f_yard is null or lower(coalesce(v.yard_sign, '')) = any (f_yard))
    and (f_volunteer is null or lower(coalesce(v.volunteer_interest, '')) = any (f_volunteer))
    and (f_newsletter is null or lower(coalesce(v.newsletter, '')) = any (f_newsletter))
    and (f_donated is null or lower(coalesce(v.donated, '')) = any (f_donated))
    and (f_attended is null or lower(coalesce(v.attended_event, '')) = any (f_attended))
    and (f_topic is null or lower(coalesce(v.top_main_topic, '')) = any (f_topic))
    and (f_convos_support is null or lower(coalesce(v.convos_candidate_support, '')) = any (f_convos_support))
    and (f_convos_status is null or lower(coalesce(v.convos_contact_status, '')) = any (f_convos_status))
    and (f_has_volunteer is null or not f_has_volunteer or public._is_truthy_yes(v.volunteer_interest))
    and (f_has_yard is null or not f_has_yard or public._is_truthy_yes(v.yard_sign))
    and (f_has_donated is null or not f_has_donated or public._is_truthy_yes(v.donated));
$$;
