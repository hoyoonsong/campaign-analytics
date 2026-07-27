-- Cache Idaho presence averages + universe size; refresh on campaign sync.
alter table public.campaign_sync_state
  add column if not exists avg_nearby_yard_sign_miles numeric,
  add column if not exists avg_nearby_volunteer_miles numeric,
  add column if not exists avg_nearby_sample_size int,
  add column if not exists avg_nearby_scope text default 'state:ID',
  add column if not exists avg_nearby_computed_at timestamptz,
  add column if not exists universe_total bigint;

create or replace function public.refresh_presence_cache()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  avg_json jsonb;
  uni bigint;
begin
  perform set_config('statement_timeout', '60s', true);

  select count(*) into uni from public.voters;

  -- Campaign focus: Idaho residence averages (stable until next sync).
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
    universe_total = uni,
    updated_at = now()
  where id = 1;

  return jsonb_build_object(
    'universe_total', uni,
    'avg', avg_json,
    'scope', 'state:ID'
  );
end;
$$;

revoke all on function public.refresh_presence_cache() from public;
grant execute on function public.refresh_presence_cache() to service_role;

-- Seed cache now (so Analytics has numbers without waiting for a sync).
select public.refresh_presence_cache();
