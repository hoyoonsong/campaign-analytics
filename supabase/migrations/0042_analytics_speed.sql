-- Unfiltered Analytics was rescanning voters once per chart (CTEs inlined)
-- and campaign sync + filter-options piled on after import wiped the cache.
-- Scan once into a temp table, cheap bit_count, one-pass filter options.

create or replace function public._popcount(n bigint)
returns integer
language sql
immutable
parallel safe
as $$
  select case
    when n is null or n = 0 then 0
    else bit_count(n::bit(64))::integer
  end;
$$;

create or replace function public.voter_analytics_summary(filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  f jsonb := coalesce(filters, '{}'::jsonb);
  f_county text[]; f_party text[]; f_city text[]; f_zip text[]; f_status text[];
  f_state text[];
  x_county text[]; x_party text[]; x_city text[]; x_zip text[]; x_status text[];
  x_state text[];
  f_age_min int; f_age_max int; f_support_min int; f_support_max int;
  x_age_min int; x_age_max int; x_support_min int; x_support_max int;
  f_has_coords boolean; f_signed text[]; f_signed_any boolean; f_signed_all_core boolean;
  x_signed text[];
  f_alignment text[]; f_yard text[]; f_volunteer text[]; f_newsletter text[];
  f_donated text[]; f_attended text[]; f_topic text[]; f_convos_support text[]; f_convos_status text[];
  x_alignment text[]; x_yard text[]; x_volunteer text[]; x_newsletter text[];
  x_donated text[]; x_attended text[]; x_topic text[]; x_convos_support text[]; x_convos_status text[];
  f_has_volunteer boolean; f_has_yard boolean; f_has_donated boolean;
  x_has_volunteer boolean; x_has_yard boolean; x_has_donated boolean;
  x_campaign_volunteer boolean;
  f_supporter_tag text[];
  x_supporter_tag text[];
  f_nearby_yard double precision; f_nearby_vol double precision;
  f_any_of jsonb;
  f_signed_min int;
  signed_min_of text[];
  f_petitions text[];
  need_mask bigint; excl_mask bigint; core_mask bigint; signed_min_mask bigint; sel_mask bigint;
  has_row_filters boolean;
  result jsonb;
begin
  perform set_config('statement_timeout', '60s', true);
  perform set_config('jit', 'off', true);
  perform set_config('work_mem', '32MB', true);

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
  f_supporter_tag := public._lower_text_array(public._jsonb_text_array(f, 'supporter_tag'));
  x_supporter_tag := public._lower_text_array(public._jsonb_text_array(f, 'exclude_supporter_tag'));
  f_nearby_yard := nullif(f->>'nearby_yard_sign_miles', '')::double precision;
  f_nearby_vol := nullif(f->>'nearby_volunteer_miles', '')::double precision;
  f_any_of := f->'any_of';

  f_signed_min := nullif(f->>'signed_min', '')::int;
  signed_min_of := public._jsonb_text_array(f, 'signed_min_of');
  f_petitions := public._jsonb_text_array(f, 'petitions');
  if f_petitions is null or cardinality(f_petitions) = 0 then
    f_petitions := public._default_petition_slugs();
  end if;
  need_mask := public._petition_mask(f_signed);
  excl_mask := public._petition_mask(x_signed);
  core_mask := public._core_petition_mask();
  sel_mask := public._petition_mask(f_petitions);
  signed_min_mask := case
    when signed_min_of is not null then public._petition_mask(signed_min_of)
    else -1::bigint
  end;

  has_row_filters :=
    f_county is not null or f_party is not null or f_city is not null or f_zip is not null or f_status is not null or f_state is not null
    or x_county is not null or x_party is not null or x_city is not null or x_zip is not null or x_status is not null or x_state is not null
    or f_age_min is not null or f_age_max is not null or f_support_min is not null or f_support_max is not null
    or x_age_min is not null or x_age_max is not null or x_support_min is not null or x_support_max is not null
    or f_has_coords is not null or f_signed is not null or x_signed is not null
    or f_signed_any is not null or f_signed_all_core is not null
    or f_signed_min is not null
    or need_mask <> 0 or excl_mask <> 0
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
    or f_supporter_tag is not null or x_supporter_tag is not null
    or (
      f_any_of is not null
      and jsonb_typeof(f_any_of) = 'array'
      and jsonb_array_length(f_any_of) > 0
    );

  drop table if exists _analytics_base;
  if not has_row_filters then
    create temporary table _analytics_base on commit drop as
    select
      v.county, v.party, v.status, v.age, v.birth_year, v.lat, v.lng, v.supporter_tag,
      coalesce(v.signed_mask, 0) as signed_mask,
      (coalesce(v.signed_mask, 0) & sel_mask) as combo_mask
    from public.voters v;
  else
    create temporary table _analytics_base on commit drop as
    select
      v.county, v.party, v.status, v.age, v.birth_year, v.lat, v.lng, v.supporter_tag,
      coalesce(v.signed_mask, 0) as signed_mask,
      (coalesce(v.signed_mask, 0) & sel_mask) as combo_mask
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
      and public._state_matches(v.state, f_state, false)
      and public._arr_match(v.county, x_county, true)
      and public._arr_match(v.party, x_party, true)
      and public._arr_match(v.city, x_city, true)
      and (x_zip is null or not (v.zip = any (x_zip)))
      and public._arr_match(v.status, x_status, true)
      and public._state_matches(v.state, x_state, true)
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
      and (need_mask = 0 or (v.signed_mask & need_mask) = need_mask)
      and (excl_mask = 0 or (v.signed_mask & excl_mask) = 0)
      and (f_signed_any is null or not f_signed_any or v.signed_mask <> 0)
      and (f_signed_all_core is null or not f_signed_all_core or (v.signed_mask & core_mask) = core_mask)
      and (f_signed_min is null or public._popcount(v.signed_mask & signed_min_mask) >= f_signed_min)
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
        f_supporter_tag is null
        or lower(coalesce(v.supporter_tag, '')) = any (f_supporter_tag)
      )
      and (
        x_supporter_tag is null
        or not (lower(coalesce(v.supporter_tag, '')) = any (x_supporter_tag))
      )
      and (
        f_nearby_yard is null
        or public._has_nearby_geo(v.lat, v.lng, 'yard_sign', f_nearby_yard)
      )
      and (
        f_nearby_vol is null
        or public._has_nearby_geo(v.lat, v.lng, 'volunteer', f_nearby_vol)
      );
  end if;

  with sel_petitions as (
    select p.slug, p.label, p.short_label, p.bit_index, p.sort_order, p.is_default
    from public.petitions p
    where p.is_active
      and (f_petitions is null or p.slug = any (f_petitions))
  ),
  agg as (
    select
      count(*)::bigint as total,
      count(*) filter (where lat is not null and lng is not null)::bigint as with_coords,
      count(*) filter (where combo_mask <> 0 and (combo_mask & (combo_mask - 1)) <> 0)::bigint as super_signers,
      count(*) filter (where combo_mask <> 0)::bigint as signed_any_selected,
      count(*) filter (where (signed_mask & core_mask) = core_mask and core_mask <> 0)::bigint as signed_all_core,
      count(*) filter (where signed_mask <> 0)::bigint as signed_any
    from _analytics_base
  ),
  by_county as (
    select coalesce(nullif(county, ''), '(blank)') as key, count(*)::bigint as count
    from _analytics_base group by 1 order by count desc, key limit 100
  ),
  by_party as (
    select coalesce(nullif(party, ''), '(blank)') as key, count(*)::bigint as count
    from _analytics_base group by 1 order by count desc, key limit 50
  ),
  by_status as (
    select coalesce(nullif(status, ''), '(blank)') as key, count(*)::bigint as count
    from _analytics_base group by 1 order by count desc, key limit 50
  ),
  by_supporter_tag as (
    select coalesce(nullif(lower(supporter_tag), ''), '(untagged)') as key, count(*)::bigint as count
    from _analytics_base group by 1 order by count desc, key
  ),
  by_age as (
    select
      case
        when coalesce(age, case when birth_year is not null then extract(year from current_date)::int - birth_year end) is null then 'Unknown'
        when coalesce(age, extract(year from current_date)::int - birth_year) < 18 then 'Under 18'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 18 and 24 then '18–24'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 25 and 34 then '25–34'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 35 and 44 then '35–44'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 45 and 54 then '45–54'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 55 and 64 then '55–64'
        else '65+'
      end as key,
      count(*)::bigint as count
    from _analytics_base group by 1
  ),
  petition_combos as (
    select combo_mask as mask, count(*)::bigint as count
    from _analytics_base
    where combo_mask <> 0
    group by 1
  ),
  by_petition_count as (
    select public._popcount(mask)::text as key, sum(count)::bigint as count
    from (
      select combo_mask as mask, count(*)::bigint as count
      from _analytics_base
      group by 1
    ) s
    group by 1
    order by 1
  ),
  by_signature as (
    select p.slug, p.label, p.sort_order,
      coalesce((
        select sum(c.count)
        from petition_combos c
        where (c.mask & (1::bigint << p.bit_index)) <> 0
      ), 0)::bigint as count
    from sel_petitions p
  )
  select jsonb_build_object(
    'total', a.total,
    'with_coords', a.with_coords,
    'super_signers', a.super_signers,
    'by_county', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_county), '[]'::jsonb),
    'by_party', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_party), '[]'::jsonb),
    'by_status', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_status), '[]'::jsonb),
    'by_supporter_tag', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_supporter_tag), '[]'::jsonb),
    'supporters', coalesce((select count from by_supporter_tag where key = 'supporter'), 0),
    'maybes', coalesce((select count from by_supporter_tag where key = 'maybe'), 0),
    'opposed', coalesce((select count from by_supporter_tag where key = 'opposed'), 0),
    'by_age', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_age), '[]'::jsonb),
    'signatures', jsonb_build_object(
      'signed_all_core', a.signed_all_core,
      'signed_any', a.signed_any,
      'super_signers', a.super_signers
    ),
    'petitions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'slug', slug,
        'label', label,
        'short_label', short_label,
        'bit_index', bit_index,
        'sort_order', sort_order,
        'is_default', is_default
      ) order by sort_order, slug)
      from sel_petitions
    ), '[]'::jsonb),
    'by_signature', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', label,
        'slug', slug,
        'count', count
      ) order by sort_order, slug)
      from by_signature
    ), '[]'::jsonb),
    'by_petition_count', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_petition_count), '[]'::jsonb),
    'petition_combos', coalesce((
      select jsonb_agg(jsonb_build_object('mask', mask, 'count', count) order by count desc, mask)
      from petition_combos
    ), '[]'::jsonb)
  ) into result from agg a;

  return result;
end;
$$;

revoke all on function public.voter_analytics_summary(jsonb) from public;
grant execute on function public.voter_analytics_summary(jsonb) to service_role;

-- One seq scan instead of ~12 distinct-on full-table scans.
create or replace function public.voter_filter_options()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  perform set_config('statement_timeout', '30s', true);
  perform set_config('jit', 'off', true);
  perform set_config('work_mem', '32MB', true);

  drop table if exists _filter_opt_base;
  create temporary table _filter_opt_base on commit drop as
  select
    county, party, status, state, city,
    alignment_label, yard_sign, volunteer_interest, newsletter,
    donated, attended_event, top_main_topic,
    convos_candidate_support, convos_contact_status
  from public.voters;

  select jsonb_build_object(
    'counties', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(county)) county as x
      from _filter_opt_base
      where nullif(trim(county), '') is not null
        and lower(trim(coalesce(state, ''))) in ('id', 'idaho')
      order by lower(county), county
      limit 200
    ) s), '[]'::jsonb),
    'parties', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(party)) party as x
      from _filter_opt_base
      where nullif(trim(party), '') is not null
      order by lower(party), party
      limit 100
    ) s), '[]'::jsonb),
    'statuses', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(status)) status as x
      from _filter_opt_base
      where nullif(trim(status), '') is not null
      order by lower(status), status
      limit 50
    ) s), '[]'::jsonb),
    'states', coalesce((select jsonb_agg(x order by x) from (
      select distinct upper(trim(state)) as x
      from _filter_opt_base
      where nullif(trim(state), '') is not null
      limit 60
    ) s), '[]'::jsonb),
    'cities', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(city)) city as x
      from _filter_opt_base
      where nullif(trim(city), '') is not null
        and lower(trim(coalesce(state, ''))) in ('id', 'idaho')
      order by lower(city), city
      limit 2000
    ) s), '[]'::jsonb),
    'alignment_labels', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(alignment_label)) alignment_label as x
      from _filter_opt_base
      where nullif(trim(alignment_label), '') is not null
      order by lower(alignment_label), alignment_label
      limit 50
    ) s), '[]'::jsonb),
    'yard_signs', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(yard_sign)) yard_sign as x
      from _filter_opt_base
      where nullif(trim(yard_sign), '') is not null
      order by lower(yard_sign), yard_sign
      limit 50
    ) s), '[]'::jsonb),
    'volunteer_interests', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(volunteer_interest)) volunteer_interest as x
      from _filter_opt_base
      where nullif(trim(volunteer_interest), '') is not null
      order by lower(volunteer_interest), volunteer_interest
      limit 50
    ) s), '[]'::jsonb),
    'newsletters', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(newsletter)) newsletter as x
      from _filter_opt_base
      where nullif(trim(newsletter), '') is not null
      order by lower(newsletter), newsletter
      limit 50
    ) s), '[]'::jsonb),
    'donated', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(donated)) donated as x
      from _filter_opt_base
      where nullif(trim(donated), '') is not null
      order by lower(donated), donated
      limit 50
    ) s), '[]'::jsonb),
    'attended_events', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(attended_event)) attended_event as x
      from _filter_opt_base
      where nullif(trim(attended_event), '') is not null
      order by lower(attended_event), attended_event
      limit 50
    ) s), '[]'::jsonb),
    'top_main_topics', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(top_main_topic)) top_main_topic as x
      from _filter_opt_base
      where nullif(trim(top_main_topic), '') is not null
      order by lower(top_main_topic), top_main_topic
      limit 100
    ) s), '[]'::jsonb),
    'convos_candidate_support', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(convos_candidate_support)) convos_candidate_support as x
      from _filter_opt_base
      where nullif(trim(convos_candidate_support), '') is not null
      order by lower(convos_candidate_support), convos_candidate_support
      limit 50
    ) s), '[]'::jsonb),
    'convos_contact_status', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(convos_contact_status)) convos_contact_status as x
      from _filter_opt_base
      where nullif(trim(convos_contact_status), '') is not null
      order by lower(convos_contact_status), convos_contact_status
      limit 50
    ) s), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.voter_filter_options() from public;
grant execute on function public.voter_filter_options() to service_role;

-- Cache analytics + filter options first; avg-nearby is best-effort so a geo
-- timeout cannot wipe a just-rebuilt analytics cache.
create or replace function public.refresh_presence_cache()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  avg_json jsonb;
  summary_json jsonb;
  options_json jsonb;
  uni bigint;
begin
  perform set_config('statement_timeout', '60s', true);
  perform set_config('jit', 'off', true);

  select count(*) into uni from public.voters;

  summary_json := public.voter_analytics_summary('{}'::jsonb);
  options_json := public.voter_filter_options();

  update public.campaign_sync_state set
    universe_total = uni,
    analytics_summary_cache = summary_json,
    analytics_summary_cached_at = now(),
    filter_options_cache = options_json,
    filter_options_cached_at = now(),
    updated_at = now()
  where id = 1;

  begin
    avg_json := public.voter_avg_nearby(
      jsonb_build_object('state', jsonb_build_array('ID')),
      2000
    );
    update public.campaign_sync_state set
      avg_nearby_yard_sign_miles = nullif(avg_json->>'avg_nearby_yard_sign_miles', '')::numeric,
      avg_nearby_volunteer_miles = nullif(avg_json->>'avg_nearby_volunteer_miles', '')::numeric,
      avg_nearby_sample_size = coalesce((avg_json->>'avg_nearby_sample_size')::int, 0),
      avg_nearby_scope = 'state:ID',
      avg_nearby_computed_at = now(),
      updated_at = now()
    where id = 1;
  exception when others then
    avg_json := jsonb_build_object('error', sqlerrm);
  end;

  return jsonb_build_object(
    'universe_total', uni,
    'avg', avg_json,
    'scope', 'state:ID',
    'analytics_cached', summary_json is not null,
    'analytics_total', summary_json->>'total',
    'filter_options_cached', options_json is not null
  );
end;
$$;

revoke all on function public.refresh_presence_cache() from public;
grant execute on function public.refresh_presence_cache() to service_role;

notify pgrst, 'reload schema';
