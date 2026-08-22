-- Per-county {id, lat, lng} snapshots for the Analytics map.
-- Rebuilt on demand after import (version bump); the browser caches by version.

alter table public.campaign_sync_state
  add column if not exists map_coords_version bigint not null default 0;

create table if not exists public.voter_map_county_snapshots (
  county text primary key,
  version bigint not null,
  point_count int not null default 0,
  payload jsonb not null default '{}'::jsonb,
  built_at timestamptz not null default now()
);

alter table public.voter_map_county_snapshots enable row level security;

-- Bump the cache key. Stale county rows are replaced the next time they are opened.
create or replace function public.invalidate_voter_map_snapshots()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  ver bigint;
begin
  update public.campaign_sync_state
  set
    map_coords_version = coalesce(map_coords_version, 0) + 1,
    updated_at = now()
  where id = 1
  returning map_coords_version into ver;

  if ver is null then
    insert into public.campaign_sync_state (id, map_coords_version, updated_at)
    values (1, 1, now())
    on conflict (id) do update set
      map_coords_version = public.campaign_sync_state.map_coords_version + 1,
      updated_at = now()
    returning map_coords_version into ver;
  end if;

  return coalesce(ver, 1);
end;
$$;

create or replace function public.rebuild_voter_map_county(p_county text)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
set jit = off
as $$
declare
  want text := trim(coalesce(p_county, ''));
  ver bigint;
  n int;
  payload jsonb;
begin
  if want = '' then
    return jsonb_build_object('error', 'county required');
  end if;

  update public.campaign_sync_state
  set map_coords_version = 1, updated_at = now()
  where id = 1 and coalesce(map_coords_version, 0) = 0;

  select coalesce(map_coords_version, 1) into ver
  from public.campaign_sync_state
  where id = 1;

  if ver is null then
    insert into public.campaign_sync_state (id, map_coords_version, updated_at)
    values (1, 1, now())
    on conflict (id) do update set map_coords_version = 1, updated_at = now();
    ver := 1;
  end if;

  select
    jsonb_build_object(
      'ids', coalesce(jsonb_agg(s.id), '[]'::jsonb),
      'lat', coalesce(jsonb_agg(s.lat), '[]'::jsonb),
      'lng', coalesce(jsonb_agg(s.lng), '[]'::jsonb)
    ),
    count(*)::int
  into payload, n
  from (
    select
      v.id,
      round(v.lat::numeric, 5)::double precision as lat,
      round(v.lng::numeric, 5)::double precision as lng
    from public.voters v
    where v.lat is not null
      and v.lng is not null
      and (
        lower(trim(v.county)) in (lower(want), lower(want) || ' county')
      )
  ) s;

  insert into public.voter_map_county_snapshots as snap
    (county, version, point_count, payload, built_at)
  values (want, ver, n, payload, now())
  on conflict (county) do update set
    version = excluded.version,
    point_count = excluded.point_count,
    payload = excluded.payload,
    built_at = excluded.built_at;

  return payload || jsonb_build_object(
    'version', ver,
    'county', want,
    'count', n
  );
end;
$$;

-- Serve a county snapshot. Pass p_have_version from IndexedDB to skip the payload.
create or replace function public.voter_map_county_snapshot(
  p_county text,
  p_have_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
set jit = off
as $$
declare
  want text := trim(coalesce(p_county, ''));
  ver bigint;
  snap_ver bigint;
  n int;
  payload jsonb;
begin
  if want = '' then
    return jsonb_build_object('error', 'county required');
  end if;

  select coalesce(map_coords_version, 0) into ver
  from public.campaign_sync_state
  where id = 1;
  ver := coalesce(ver, 0);

  select s.version, s.point_count, s.payload
  into snap_ver, n, payload
  from public.voter_map_county_snapshots s
  where s.county = want;

  if snap_ver is not null and snap_ver = ver and ver > 0 then
    if p_have_version is not null and p_have_version = ver then
      return jsonb_build_object(
        'unchanged', true,
        'version', ver,
        'county', want,
        'count', n
      );
    end if;
    return coalesce(payload, '{}'::jsonb) || jsonb_build_object(
      'version', ver,
      'county', want,
      'count', n
    );
  end if;

  return public.rebuild_voter_map_county(want);
end;
$$;

revoke all on function public.invalidate_voter_map_snapshots() from public;
revoke all on function public.rebuild_voter_map_county(text) from public;
revoke all on function public.voter_map_county_snapshot(text, bigint) from public;

grant execute on function public.invalidate_voter_map_snapshots() to service_role;
grant execute on function public.rebuild_voter_map_county(text) to service_role;
grant execute on function public.voter_map_county_snapshot(text, bigint) to service_role;
