-- Petition + campaign-attribute filters.
-- Hot paths parse filters once into locals (free-tier safe).

create or replace function public._is_signed(val text)
returns boolean
language sql
immutable
as $$
  select lower(trim(coalesce(val, ''))) in (
    'true', 't', 'yes', 'y', '1', 'signed', 'x', 'valid'
  );
$$;

create or replace function public._is_truthy_yes(val text)
returns boolean
language sql
immutable
as $$
  select lower(trim(coalesce(val, ''))) in (
    'true', 't', 'yes', 'y', '1', 'delivered'
  );
$$;

create or replace function public._lower_text_array(arr text[])
returns text[]
language sql
immutable
as $$
  select case
    when arr is null then null
    else array(select lower(x) from unnest(arr) as x)
  end;
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
      count(*) filter (where s_open and s_repro and s_achilles and s_cannabis)::bigint as signed_all_four,
      count(*) filter (where s_open or s_repro or s_achilles or s_cannabis)::bigint as signed_any
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
  has_filters boolean;
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

  has_filters :=
    f_county is not null or f_party is not null or f_city is not null
    or f_zip is not null or f_status is not null
    or f_age_min is not null or f_age_max is not null
    or f_support_min is not null or f_support_max is not null
    or f_has_coords is not null or f_signed is not null
    or f_signed_any is not null or f_signed_all_core is not null
    or f_alignment is not null or f_yard is not null or f_volunteer is not null
    or f_newsletter is not null or f_donated is not null or f_attended is not null
    or f_topic is not null or f_convos_support is not null or f_convos_status is not null
    or f_has_volunteer is not null or f_has_yard is not null or f_has_donated is not null;

  if needle is null and not has_filters then
    select count(*) into total_count from public.voters;
    select coalesce(
      jsonb_agg(to_jsonb(t) order by t.last_name nulls last, t.first_name nulls last, t.id),
      '[]'::jsonb
    )
    into rows_json
    from (
      select
        id, murmuration_id, voter_id, first_name, last_name, email, phone,
        address_line_1, city, state, zip, county, party,
        age, status, support_score, lat, lng
      from public.voters
      order by last_name nulls last, first_name nulls last, id
      offset offset_rows
      limit safe_size
    ) t;

    return jsonb_build_object(
      'rows', rows_json,
      'total', total_count,
      'page', safe_page,
      'page_size', safe_size
    );
  end if;

  with matched as (
    select
      v.id, v.murmuration_id, v.voter_id, v.first_name, v.last_name, v.email, v.phone,
      v.address_line_1, v.city, v.state, v.zip, v.county, v.party,
      v.age, v.status, v.support_score, v.lat, v.lng,
      count(*) over() as full_count
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
      and (
        needle is null
        or v.murmuration_id ilike '%' || needle || '%'
        or v.voter_id ilike '%' || needle || '%'
        or v.first_name ilike '%' || needle || '%'
        or v.last_name ilike '%' || needle || '%'
        or (coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')) ilike '%' || needle || '%'
        or v.address_line_1 ilike '%' || needle || '%'
        or v.city ilike '%' || needle || '%'
        or v.zip ilike '%' || needle || '%'
        or v.email ilike '%' || needle || '%'
        or v.phone ilike '%' || needle || '%'
      )
    order by v.last_name nulls last, v.first_name nulls last, v.id
    offset offset_rows
    limit safe_size
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
          'lng', lng
        )
        order by last_name nulls last, first_name nulls last, id
      ),
      '[]'::jsonb
    )
  into total_count, rows_json
  from matched;

  return jsonb_build_object(
    'rows', rows_json,
    'total', coalesce(total_count, 0),
    'page', safe_page,
    'page_size', safe_size
  );
end;
$$;

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

-- Map/export: shared matcher (filter arrays re-parsed per row — fine for capped pin loads).
create or replace function public.voters_match_filters(v public.voters, filters jsonb)
returns boolean
language sql
stable
as $$
  select public._voter_matches_locals(
    v,
    public._lower_text_array(public._jsonb_text_array(filters, 'county')),
    public._lower_text_array(public._jsonb_text_array(filters, 'party')),
    public._lower_text_array(public._jsonb_text_array(filters, 'city')),
    public._jsonb_text_array(filters, 'zip'),
    public._lower_text_array(public._jsonb_text_array(filters, 'status')),
    nullif(filters->>'age_min', '')::int,
    nullif(filters->>'age_max', '')::int,
    nullif(filters->>'support_score_min', '')::int,
    nullif(filters->>'support_score_max', '')::int,
    nullif(filters->>'has_coords', '')::boolean,
    public._jsonb_text_array(filters, 'signed'),
    nullif(filters->>'signed_any', '')::boolean,
    nullif(filters->>'signed_all_core', '')::boolean,
    public._lower_text_array(public._jsonb_text_array(filters, 'alignment_label')),
    public._lower_text_array(public._jsonb_text_array(filters, 'yard_sign')),
    public._lower_text_array(public._jsonb_text_array(filters, 'volunteer_interest')),
    public._lower_text_array(public._jsonb_text_array(filters, 'newsletter')),
    public._lower_text_array(public._jsonb_text_array(filters, 'donated')),
    public._lower_text_array(public._jsonb_text_array(filters, 'attended_event')),
    public._lower_text_array(public._jsonb_text_array(filters, 'top_main_topic')),
    public._lower_text_array(public._jsonb_text_array(filters, 'convos_candidate_support')),
    public._lower_text_array(public._jsonb_text_array(filters, 'convos_contact_status')),
    nullif(filters->>'has_volunteer', '')::boolean,
    nullif(filters->>'has_yard_sign', '')::boolean,
    nullif(filters->>'has_donated', '')::boolean
  );
$$;

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
  perform set_config('statement_timeout', '60s', true);

  with
  counties as (
    select distinct on (lower(county)) county as key
    from public.voters where nullif(trim(county), '') is not null
    order by lower(county), county
  ),
  parties as (
    select distinct on (lower(party)) party as key
    from public.voters where nullif(trim(party), '') is not null
    order by lower(party), party
  ),
  statuses as (
    select distinct on (lower(status)) status as key
    from public.voters where nullif(trim(status), '') is not null
    order by lower(status), status
  ),
  cities as (
    select distinct on (lower(city)) city as key
    from public.voters where nullif(trim(city), '') is not null
    order by lower(city), city
  ),
  alignment_labels as (
    select distinct on (lower(alignment_label)) alignment_label as key
    from public.voters where nullif(trim(alignment_label), '') is not null
    order by lower(alignment_label), alignment_label
  ),
  yard_signs as (
    select distinct on (lower(yard_sign)) yard_sign as key
    from public.voters where nullif(trim(yard_sign), '') is not null
    order by lower(yard_sign), yard_sign
  ),
  volunteer_interests as (
    select distinct on (lower(volunteer_interest)) volunteer_interest as key
    from public.voters where nullif(trim(volunteer_interest), '') is not null
    order by lower(volunteer_interest), volunteer_interest
  ),
  newsletters as (
    select distinct on (lower(newsletter)) newsletter as key
    from public.voters where nullif(trim(newsletter), '') is not null
    order by lower(newsletter), newsletter
  ),
  donated as (
    select distinct on (lower(donated)) donated as key
    from public.voters where nullif(trim(donated), '') is not null
    order by lower(donated), donated
  ),
  attended_events as (
    select distinct on (lower(attended_event)) attended_event as key
    from public.voters where nullif(trim(attended_event), '') is not null
    order by lower(attended_event), attended_event
  ),
  top_topics as (
    select distinct on (lower(top_main_topic)) top_main_topic as key
    from public.voters where nullif(trim(top_main_topic), '') is not null
    order by lower(top_main_topic), top_main_topic
  ),
  convos_support as (
    select distinct on (lower(convos_candidate_support)) convos_candidate_support as key
    from public.voters where nullif(trim(convos_candidate_support), '') is not null
    order by lower(convos_candidate_support), convos_candidate_support
  ),
  convos_status as (
    select distinct on (lower(convos_contact_status)) convos_contact_status as key
    from public.voters where nullif(trim(convos_contact_status), '') is not null
    order by lower(convos_contact_status), convos_contact_status
  )
  select jsonb_build_object(
    'counties', coalesce((select jsonb_agg(key order by key) from counties), '[]'::jsonb),
    'parties', coalesce((select jsonb_agg(key order by key) from parties), '[]'::jsonb),
    'statuses', coalesce((select jsonb_agg(key order by key) from statuses), '[]'::jsonb),
    'cities', coalesce((select jsonb_agg(key order by key) from cities), '[]'::jsonb),
    'alignment_labels', coalesce((select jsonb_agg(key order by key) from alignment_labels), '[]'::jsonb),
    'yard_signs', coalesce((select jsonb_agg(key order by key) from yard_signs), '[]'::jsonb),
    'volunteer_interests', coalesce((select jsonb_agg(key order by key) from volunteer_interests), '[]'::jsonb),
    'newsletters', coalesce((select jsonb_agg(key order by key) from newsletters), '[]'::jsonb),
    'donated', coalesce((select jsonb_agg(key order by key) from donated), '[]'::jsonb),
    'attended_events', coalesce((select jsonb_agg(key order by key) from attended_events), '[]'::jsonb),
    'top_main_topics', coalesce((select jsonb_agg(key order by key) from top_topics), '[]'::jsonb),
    'convos_candidate_support', coalesce((select jsonb_agg(key order by key) from convos_support), '[]'::jsonb),
    'convos_contact_status', coalesce((select jsonb_agg(key order by key) from convos_status), '[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

revoke all on function public._is_signed(text) from public;
revoke all on function public._is_truthy_yes(text) from public;
revoke all on function public._lower_text_array(text[]) from public;
revoke all on function public._voter_matches_locals(
  public.voters, text[], text[], text[], text[], text[],
  int, int, int, int, boolean, text[], boolean, boolean,
  text[], text[], text[], text[], text[], text[], text[], text[], text[],
  boolean, boolean, boolean
) from public;

grant execute on function public._is_signed(text) to service_role;
grant execute on function public._is_truthy_yes(text) to service_role;
grant execute on function public._lower_text_array(text[]) to service_role;
grant execute on function public._voter_matches_locals(
  public.voters, text[], text[], text[], text[], text[],
  int, int, int, int, boolean, text[], boolean, boolean,
  text[], text[], text[], text[], text[], text[], text[], text[], text[],
  boolean, boolean, boolean
) to service_role;

revoke all on function public.voter_analytics_summary(jsonb) from public;
revoke all on function public.voter_search(jsonb, text, int, int) from public;
revoke all on function public.voter_filter_options() from public;
grant execute on function public.voter_analytics_summary(jsonb) to service_role;
grant execute on function public.voter_search(jsonb, text, int, int) to service_role;
grant execute on function public.voter_filter_options() to service_role;
