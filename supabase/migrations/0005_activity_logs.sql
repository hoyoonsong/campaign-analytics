-- Lean activity logs (same model as campaign-form-handler 0042/0043).
-- Intentional writes only — no row-level triggers (free-tier friendly).
-- actor_id is the campaign Auth user UUID (text); no FK into voter Auth.

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_id text,
  actor text,
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  source text not null default 'app'
    check (source in ('app', 'trigger', 'import', 'sync', 'system'))
);

create index if not exists activity_logs_created_at_idx
  on public.activity_logs (created_at desc);
create index if not exists activity_logs_actor_id_idx
  on public.activity_logs (actor_id);
create index if not exists activity_logs_entity_type_idx
  on public.activity_logs (entity_type);

alter table public.activity_logs enable row level security;

-- Service-role / API only.
create or replace function public.log_activity(
  p_action text,
  p_entity_type text,
  p_entity_id text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_source text default 'app',
  p_actor_id text default null,
  p_actor text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  meta jsonb := coalesce(p_metadata, '{}'::jsonb);
  meta_text text;
begin
  if p_action is null or trim(p_action) = '' then
    raise exception 'action required';
  end if;
  if p_entity_type is null or trim(p_entity_type) = '' then
    raise exception 'entity_type required';
  end if;

  meta_text := meta::text;
  if length(meta_text) > 2000 then
    meta := jsonb_build_object('truncated', true, 'bytes', length(meta_text));
  end if;

  insert into public.activity_logs (
    actor_id, actor, action, entity_type, entity_id, metadata, source
  ) values (
    nullif(trim(coalesce(p_actor_id, '')), ''),
    nullif(trim(coalesce(p_actor, '')), ''),
    trim(p_action),
    trim(p_entity_type),
    nullif(trim(coalesce(p_entity_id, '')), ''),
    meta,
    coalesce(nullif(trim(p_source), ''), 'app')
  )
  returning id into new_id;

  return new_id;
end;
$$;

create or replace function public.prune_activity_logs(p_keep_days int default 20)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  keep int := least(greatest(coalesce(p_keep_days, 20), 14), 60);
  deleted int;
begin
  delete from public.activity_logs
  where created_at < now() - make_interval(days => keep);
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

create or replace function public.list_activity_logs(
  p_limit int default 200,
  p_offset int default 0,
  p_actor_id text default null,
  p_entity_type text default null,
  p_q text default null
)
returns setof public.activity_logs
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.activity_logs
  where action <> 'sync'
    and (p_actor_id is null or actor_id = p_actor_id)
    and (p_entity_type is null or entity_type = p_entity_type)
    and (
      p_q is null or trim(p_q) = ''
      or actor ilike '%' || trim(p_q) || '%'
      or action ilike '%' || trim(p_q) || '%'
      or entity_type ilike '%' || trim(p_q) || '%'
    )
  order by created_at desc
  limit least(greatest(coalesce(p_limit, 200), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.log_activity(text, text, text, jsonb, text, text, text) from public;
revoke all on function public.prune_activity_logs(int) from public;
revoke all on function public.list_activity_logs(int, int, text, text, text) from public;

grant execute on function public.log_activity(text, text, text, jsonb, text, text, text) to service_role;
grant execute on function public.prune_activity_logs(int) to service_role;
grant execute on function public.list_activity_logs(int, int, text, text, text) to service_role;
