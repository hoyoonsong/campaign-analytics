-- Geographic stratified sampling for map pins.
--
-- Old behavior: ORDER BY id LIMIT N — early-imported / low-id rows dominated,
-- so large counties looked empty in places that weren't imported first.
--
-- New behavior: when over the cap, bin matching coords into a ~3.5mi grid and
-- take a stable hash-ordered sample from every occupied cell so sparse towns
-- still show up alongside denser cities.

CREATE OR REPLACE FUNCTION public.voter_map_points(
  filters jsonb DEFAULT '{}'::jsonb,
  lim integer DEFAULT 2500
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  f jsonb := coalesce(filters, '{}'::jsonb);
  safe_limit int := least(greatest(coalesce(lim, 2500), 1), 8000);
  total_with_coords bigint;
  rows_json jsonb;
  f_county text[]; f_party text[]; f_city text[]; f_zip text[]; f_status text[]; f_state text[];
  x_state text[];
  f_supporter_tag text[];
  x_supporter_tag text[];
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

  -- Count matching voters with coords (same filter set as before).
  if not has_filters then
    select count(*) into total_with_coords
    from public.voters v
    where v.lat is not null and v.lng is not null;
  else
    select count(*) into total_with_coords
    from public.voters v
    where v.lat is not null and v.lng is not null
      and public._arr_match(v.county, f_county, false)
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
      );
  end if;

  -- Fast path: everything fits — no sampling needed.
  if coalesce(total_with_coords, 0) <= safe_limit then
    if not has_filters then
      select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb)
      into rows_json
      from (
        select id, murmuration_id, voter_id, first_name, last_name,
               address_line_1, city, county, zip, party, status, age, support_score, lat, lng
        from public.voters v
        where v.lat is not null and v.lng is not null
        order by v.id
      ) t;
    else
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
        order by v.id
      ) t;
    end if;

    return jsonb_build_object(
      'points', coalesce(rows_json, '[]'::jsonb),
      'returned', jsonb_array_length(coalesce(rows_json, '[]'::jsonb)),
      'total_with_coords', coalesce(total_with_coords, 0),
      'truncated', false,
      'sampling', 'all'
    );
  end if;

  -- Over the cap: geographic grid sample (~0.05° ≈ 3.5mi cells).
  with matched as (
    select
      v.id, v.murmuration_id, v.voter_id, v.first_name, v.last_name,
      v.address_line_1, v.city, v.county, v.zip, v.party, v.status, v.age,
      v.support_score, v.lat, v.lng,
      floor(v.lat / 0.05)::int as gy,
      floor(v.lng / 0.05)::int as gx
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
  ),
  ranked as (
    select
      m.*,
      row_number() over (
        partition by m.gy, m.gx
        order by md5(m.id::text)
      ) as rn
    from matched m
  ),
  cell_stats as (
    select count(*)::int as cell_count
    from (select distinct gy, gx from ranked) d
  ),
  sampled as (
    select
      r.id, r.murmuration_id, r.voter_id, r.first_name, r.last_name,
      r.address_line_1, r.city, r.county, r.zip, r.party, r.status, r.age,
      r.support_score, r.lat, r.lng
    from ranked r
    cross join cell_stats cs
    where r.rn <= greatest(
      1,
      ceil(safe_limit::numeric / greatest(cs.cell_count, 1))::int
    )
    order by r.rn, md5(r.id::text)
    limit safe_limit
  )
  select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]'::jsonb)
  into rows_json
  from sampled s;

  return jsonb_build_object(
    'points', coalesce(rows_json, '[]'::jsonb),
    'returned', jsonb_array_length(coalesce(rows_json, '[]'::jsonb)),
    'total_with_coords', coalesce(total_with_coords, 0),
    'truncated', true,
    'sampling', 'geo_grid'
  );
end;
$function$;

revoke all on function public.voter_map_points(jsonb, integer) from public;
grant execute on function public.voter_map_points(jsonb, integer) to service_role;
