-- Blank nearby max = statewide-scale search box (not a hard 50 mi cap).
create or replace function public._has_nearby_geo_range(
  p_lat double precision,
  p_lng double precision,
  p_kind text,
  p_min_miles double precision,
  p_max_miles double precision
)
returns boolean
language sql
stable
as $$
  select case
    when p_lat is null or p_lng is null then false
    when (p_min_miles is null or p_min_miles <= 0) and p_max_miles is null then false
    else exists (
      select 1
      from public.campaign_geo_points g
      where g.kind = p_kind
        and g.lat between p_lat - (coalesce(p_max_miles, 500) / 69.0)
                      and p_lat + (coalesce(p_max_miles, 500) / 69.0)
        and g.lng between p_lng - (coalesce(p_max_miles, 500) / (69.0 * greatest(cos(radians(p_lat)), 0.2)))
                      and p_lng + (coalesce(p_max_miles, 500) / (69.0 * greatest(cos(radians(p_lat)), 0.2)))
        and public._miles_between(p_lat, p_lng, g.lat, g.lng) >= coalesce(p_min_miles, 0)
        and (p_max_miles is null or public._miles_between(p_lat, p_lng, g.lat, g.lng) <= p_max_miles)
      limit 1
    )
  end;
$$;
