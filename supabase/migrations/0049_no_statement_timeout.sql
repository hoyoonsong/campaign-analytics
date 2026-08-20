-- Kill the 8s API statement_timeout that set_config() inside RPCs cannot extend.
-- Cache possible-duplicates so Search does not seq-scan voters on every click.

do $roles$
begin
  begin
    execute $sql$alter role authenticator set statement_timeout = '300s'$sql$;
  exception when others then
    raise notice 'authenticator statement_timeout: %', sqlerrm;
  end;
  begin
    execute $sql$alter role service_role set statement_timeout = '300s'$sql$;
  exception when others then
    raise notice 'service_role statement_timeout: %', sqlerrm;
  end;
  begin
    execute $sql$alter role authenticated set statement_timeout = '300s'$sql$;
  exception when others then
    raise notice 'authenticated statement_timeout: %', sqlerrm;
  end;
end
$roles$;

do $fns$
declare
  r record;
begin
  for r in
    select n.nspname as nsp, p.proname as name, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
  loop
    execute format(
      'alter function %I.%I(%s) set statement_timeout = %L',
      r.nsp, r.name, r.args, '300s'
    );
  end loop;
end
$fns$;

create table if not exists public.possible_duplicate_voters (
  id bigint primary key references public.voters(id) on delete cascade
);

create table if not exists public.possible_duplicate_state (
  id integer primary key default 1 check (id = 1),
  refreshed_at timestamptz,
  dup_count integer not null default 0
);

insert into public.possible_duplicate_state (id)
values (1)
on conflict (id) do nothing;

create index if not exists voters_dup_name_addr_idx
  on public.voters (
    lower(trim(first_name)),
    lower(trim(last_name)),
    lower(trim(address_line_1))
  )
  where coalesce(trim(first_name), '') <> ''
    and coalesce(trim(last_name), '') <> ''
    and coalesce(trim(address_line_1), '') <> '';

create or replace function public.refresh_possible_duplicates()
returns integer
language plpgsql
security definer
set search_path = public
set statement_timeout = '300s'
set jit = off
as $$
declare
  n int;
begin
  truncate public.possible_duplicate_voters;

  insert into public.possible_duplicate_voters (id)
  select v.id
  from public.voters v
  join (
    select lower(email) as k
    from public.voters
    where email is not null and email <> '' and length(trim(email)) >= 5
    group by 1
    having count(*) > 1
  ) d on lower(v.email) = d.k
  on conflict do nothing;

  insert into public.possible_duplicate_voters (id)
  select v.id
  from public.voters v
  join (
    select public._phone_digits(phone) as k
    from public.voters
    where phone is not null
      and length(coalesce(public._phone_digits(phone), '')) >= 7
    group by 1
    having count(*) > 1
  ) d on public._phone_digits(v.phone) = d.k
  on conflict do nothing;

  insert into public.possible_duplicate_voters (id)
  select v.id
  from public.voters v
  join (
    select
      lower(trim(first_name)) as fn,
      lower(trim(last_name)) as ln,
      lower(trim(address_line_1)) as addr
    from public.voters
    where coalesce(trim(first_name), '') <> ''
      and coalesce(trim(last_name), '') <> ''
      and coalesce(trim(address_line_1), '') <> ''
    group by 1, 2, 3
    having count(*) > 1
  ) d on lower(trim(v.first_name)) = d.fn
    and lower(trim(v.last_name)) = d.ln
    and lower(trim(v.address_line_1)) = d.addr
  on conflict do nothing;

  select count(*) into n from public.possible_duplicate_voters;
  insert into public.possible_duplicate_state (id, refreshed_at, dup_count)
  values (1, now(), n)
  on conflict (id) do update
    set refreshed_at = excluded.refreshed_at,
        dup_count = excluded.dup_count;
  return n;
end;
$$;

create or replace function public.ensure_possible_duplicates()
returns integer
language plpgsql
security definer
set search_path = public
set statement_timeout = '300s'
as $$
declare
  stale boolean;
  n int;
begin
  select
    refreshed_at is null
    or refreshed_at < now() - interval '12 hours'
  into stale
  from public.possible_duplicate_state
  where id = 1;

  if not coalesce(stale, true) then
    select dup_count into n from public.possible_duplicate_state where id = 1;
    return coalesce(n, 0);
  end if;

  return public.refresh_possible_duplicates();
end;
$$;

create or replace function public.mark_possible_duplicates_stale()
returns void
language sql
security definer
set search_path = public
as $$
  update public.possible_duplicate_state
  set refreshed_at = null
  where id = 1;
$$;

-- Instant lookup for voter_search / voter_export_page (they still call this).
create or replace function public._possible_duplicate_ids()
returns bigint[]
language sql
stable
security definer
set search_path = public
set statement_timeout = '300s'
as $$
  select coalesce(array_agg(id), '{}'::bigint[])
  from public.possible_duplicate_voters;
$$;

grant execute on function public.refresh_possible_duplicates() to service_role;
grant execute on function public.ensure_possible_duplicates() to service_role;
grant execute on function public.mark_possible_duplicates_stale() to service_role;
grant execute on function public._possible_duplicate_ids() to service_role;

do $rename$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'voter_search'
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'voter_search_core'
  ) then
    alter function public.voter_search(jsonb, text, integer, integer)
      rename to voter_search_core;
  end if;
end
$rename$;

create or replace function public.voter_search(
  filters jsonb default '{}'::jsonb,
  q text default ''::text,
  page integer default 1,
  page_size integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set statement_timeout = '300s'
set jit = off
as $$
declare
  f jsonb := coalesce(filters, '{}'::jsonb);
  extras jsonb := f - 'possible_duplicates';
  needle text := nullif(trim(coalesce(q, '')), '');
  safe_page int := greatest(coalesce(page, 1), 1);
  safe_size int := least(greatest(coalesce(page_size, 50), 1), 100);
  offset_rows int;
  extras_empty boolean;
  total_count bigint;
  rows_json jsonb;
begin
  select coalesce(bool_and(
    value is null
    or value = 'null'::jsonb
    or value = '[]'::jsonb
    or value = '""'::jsonb
    or value = 'false'::jsonb
  ), true)
  into extras_empty
  from jsonb_each(coalesce(extras, '{}'::jsonb));

  if extras = '{}'::jsonb or extras is null then
    extras_empty := true;
  end if;

  if coalesce(nullif(f->>'possible_duplicates', '')::boolean, false)
     and needle is null
     and extras_empty
  then
    perform public.ensure_possible_duplicates();
    offset_rows := (safe_page - 1) * safe_size;
    select count(*) into total_count from public.possible_duplicate_voters;
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'murmuration_id', t.murmuration_id,
          'voter_id', t.voter_id,
          'first_name', t.first_name,
          'last_name', t.last_name,
          'email', t.email,
          'phone', t.phone,
          'address_line_1', t.address_line_1,
          'city', t.city,
          'state', t.state,
          'zip', t.zip,
          'county', t.county,
          'party', t.party,
          'age', t.age,
          'status', t.status,
          'support_score', t.support_score,
          'lat', t.lat,
          'lng', t.lng,
          'supporter_tag', t.supporter_tag,
          'is_campaign_volunteer', t.is_campaign_volunteer,
          'campaign_person_id', t.campaign_person_id,
          'nearby_yard_sign_miles', null,
          'nearby_volunteer_miles', null
        )
        order by t.last_name nulls last, t.first_name nulls last, t.id
      ),
      '[]'::jsonb
    )
    into rows_json
    from (
      select
        v.id, v.murmuration_id, v.voter_id, v.first_name, v.last_name, v.email, v.phone,
        v.address_line_1, v.city, v.state, v.zip, v.county, v.party, v.age, v.status,
        v.support_score, v.lat, v.lng, v.supporter_tag, v.is_campaign_volunteer,
        v.campaign_person_id
      from public.possible_duplicate_voters d
      join public.voters v on v.id = d.id
      order by v.last_name nulls last, v.first_name nulls last, v.id
      offset offset_rows
      limit safe_size
    ) t;
    return jsonb_build_object(
      'rows', coalesce(rows_json, '[]'::jsonb),
      'total', coalesce(total_count, 0),
      'page', safe_page,
      'page_size', safe_size
    );
  end if;

  if coalesce(nullif(f->>'possible_duplicates', '')::boolean, false) then
    perform public.ensure_possible_duplicates();
  end if;

  return public.voter_search_core(filters, q, page, page_size);
end;
$$;

revoke all on function public.voter_search(jsonb, text, integer, integer) from public;
grant execute on function public.voter_search(jsonb, text, integer, integer) to service_role;
grant execute on function public.voter_search_core(jsonb, text, integer, integer) to service_role;
