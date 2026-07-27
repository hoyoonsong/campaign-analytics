-- Fix replace_campaign_geo: jsonb_to_recordset yields records, not jsonb.

create or replace function public.replace_campaign_geo(p_geo jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
begin
  perform set_config('statement_timeout', '60s', true);
  truncate public.campaign_geo_points;
  if p_geo is null or jsonb_typeof(p_geo) <> 'array' or jsonb_array_length(p_geo) = 0 then
    return jsonb_build_object('geo_count', 0);
  end if;

  insert into public.campaign_geo_points (source_id, kind, lat, lng)
  select distinct on (kind, source_id)
    source_id, kind, lat, lng
  from (
    select
      coalesce(nullif(trim(x.source_id), '')::uuid, gen_random_uuid()) as source_id,
      x.kind,
      x.lat,
      x.lng
    from jsonb_to_recordset(p_geo) as x(
      source_id text,
      kind text,
      lat double precision,
      lng double precision
    )
    where x.kind in ('volunteer', 'yard_sign')
      and x.lat is not null
      and x.lng is not null
  ) s
  order by kind, source_id;

  get diagnostics n = row_count;
  return jsonb_build_object('geo_count', n);
end;
$$;

revoke all on function public.replace_campaign_geo(jsonb) from public;
grant execute on function public.replace_campaign_geo(jsonb) to service_role;
