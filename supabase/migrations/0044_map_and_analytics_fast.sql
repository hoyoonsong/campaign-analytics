-- Faster county map pins + unfiltered Analytics covers every active petition
-- so the UI can slice charts locally (no RPC per picker change).

create or replace function public._active_petition_slugs()
returns text[]
language sql
stable
as $$
  select coalesce(
    array_agg(p.slug order by p.sort_order, p.slug),
    '{}'::text[]
  )
  from public.petitions p
  where p.is_active;
$$;

-- voter_analytics_summary calls this when filters.petitions is omitted.
-- Return every active slug so the cached snapshot includes all bars/combos.
create or replace function public._default_petition_slugs()
returns text[]
language sql
stable
as $$
  select public._active_petition_slugs();
$$;

create index if not exists voters_county_lower_geo_idx
  on public.voters (lower(trim(county)))
  where lat is not null and lng is not null;

-- County click (Analytics map): skip count(*) + window-function grid sample.
-- Those two full passes over Ada-sized counties were hitting statement_timeout.
create or replace function public.voter_map_points(
  filters jsonb default '{}'::jsonb,
  lim integer default 2500
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  f jsonb := coalesce(filters, '{}'::jsonb);
  safe_limit int := least(greatest(coalesce(lim, 2500), 1), 4000);
  rows_json jsonb;
  f_county text[]; f_party text[]; f_city text[]; f_zip text[]; f_status text[];
  f_state text[]; x_state text[];
  f_supporter_tag text[]; x_supporter_tag text[];
  f_nearby_yard double precision; f_nearby_vol double precision;
  f_nearby_yard_min double precision; f_nearby_vol_min double precision;
  county_only boolean;
  has_filters boolean;
begin
  perform set_config('statement_timeout', '20s', true);
  perform set_config('jit', 'off', true);

  f_county := public._lower_text_array(public._jsonb_text_array(f, 'county'));
  f_party := public._lower_text_array(public._jsonb_text_array(f, 'party'));
  f_city := public._lower_text_array(public._jsonb_text_array(f, 'city'));
  f_zip := public._jsonb_text_array(f, 'zip');
  f_status := public._lower_text_array(public._jsonb_text_array(f, 'status'));
  f_state := public._lower_text_array(public._jsonb_text_array(f, 'state'));
  x_state := public._lower_text_array(public._jsonb_text_array(f, 'exclude_state'));
  f_supporter_tag := public._lower_text_array(public._jsonb_text_array(f, 'supporter_tag'));
  x_supporter_tag := public._lower_text_array(public._jsonb_text_array(f, 'exclude_supporter_tag'));
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
    or f_status is not null or f_state is not null or x_state is not null
    or f_supporter_tag is not null or x_supporter_tag is not null
    or f_nearby_yard is not null or f_nearby_vol is not null
    or f_nearby_yard_min is not null or f_nearby_vol_min is not null
    or (f ? 'any_of' and jsonb_typeof(f->'any_of') = 'array' and jsonb_array_length(f->'any_of') > 0)
    or (f ? 'signed' and jsonb_typeof(f->'signed') = 'array' and jsonb_array_length(f->'signed') > 0);

  county_only :=
    f_county is not null
    and f_party is null and f_city is null and f_zip is null
    and f_status is null and f_state is null and x_state is null
    and f_supporter_tag is null and x_supporter_tag is null
    and f_nearby_yard is null and f_nearby_vol is null
    and f_nearby_yard_min is null and f_nearby_vol_min is null
    and not (f ? 'any_of' and jsonb_typeof(f->'any_of') = 'array' and jsonb_array_length(f->'any_of') > 0)
    and not (f ? 'signed' and jsonb_typeof(f->'signed') = 'array' and jsonb_array_length(f->'signed') > 0);

  if county_only then
    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
    into rows_json
    from (
      select id, murmuration_id, voter_id, first_name, last_name,
             address_line_1, city, county, zip, party, status, age, support_score, lat, lng
      from public.voters v
      where v.lat is not null and v.lng is not null
        and (
          lower(trim(v.county)) = any (f_county)
          or lower(trim(v.county)) = any (
            select x || ' county' from unnest(f_county) as x
          )
        )
      order by mod(v.id * 1103515245, 2147483647)
      limit safe_limit
    ) t;

    return jsonb_build_object(
      'points', coalesce(rows_json, '[]'::jsonb),
      'returned', jsonb_array_length(coalesce(rows_json, '[]'::jsonb)),
      'total_with_coords', jsonb_array_length(coalesce(rows_json, '[]'::jsonb)),
      'truncated', jsonb_array_length(coalesce(rows_json, '[]'::jsonb)) >= safe_limit,
      'sampling', 'county_fast'
    );
  end if;

  -- Other filter sets: hash-ordered cap, no pre-count, no window over the full match.
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
  into rows_json
  from (
    select id, murmuration_id, voter_id, first_name, last_name,
           address_line_1, city, county, zip, party, status, age, support_score, lat, lng
    from public.voters v
    where v.lat is not null and v.lng is not null
      and (
        not has_filters
        or (
          public._arr_match(v.county, f_county, false)
          and public._arr_match(v.party, f_party, false)
          and public._arr_match(v.city, f_city, false)
          and (f_zip is null or v.zip = any (f_zip))
          and public._arr_match(v.status, f_status, false)
          and public._state_matches(v.state, f_state, false)
          and public._state_matches(v.state, x_state, true)
          and (
            f_supporter_tag is null
            or lower(coalesce(v.supporter_tag, '')) = any (f_supporter_tag)
          )
          and (
            x_supporter_tag is null
            or not (lower(coalesce(v.supporter_tag, '')) = any (x_supporter_tag))
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
        )
      )
    order by mod(v.id * 1103515245, 2147483647)
    limit safe_limit
  ) t;

  return jsonb_build_object(
    'points', coalesce(rows_json, '[]'::jsonb),
    'returned', jsonb_array_length(coalesce(rows_json, '[]'::jsonb)),
    'total_with_coords', jsonb_array_length(coalesce(rows_json, '[]'::jsonb)),
    'truncated', jsonb_array_length(coalesce(rows_json, '[]'::jsonb)) >= safe_limit,
    'sampling', case when has_filters then 'hash_cap' else 'hash_cap_all' end
  );
end;
$function$;

revoke all on function public.voter_map_points(jsonb, integer) from public;
grant execute on function public.voter_map_points(jsonb, integer) to service_role;
