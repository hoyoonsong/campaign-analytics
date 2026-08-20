-- Possible duplicates must be the same person, not the same household.
-- Shared phones/emails were flagging spouses (Penny/Steven Adams).

create or replace function public._given_name(n text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(lower(trim(split_part(trim(coalesce(n, '')), ' ', 1))), '');
$$;

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

  -- Same given name + last name + street
  insert into public.possible_duplicate_voters (id)
  select v.id
  from public.voters v
  join (
    select
      public._given_name(first_name) as fn,
      lower(trim(last_name)) as ln,
      lower(trim(address_line_1)) as addr
    from public.voters
    where public._given_name(first_name) is not null
      and coalesce(trim(last_name), '') <> ''
      and coalesce(trim(address_line_1), '') <> ''
    group by 1, 2, 3
    having count(*) > 1
  ) d on public._given_name(v.first_name) = d.fn
    and lower(trim(v.last_name)) = d.ln
    and lower(trim(v.address_line_1)) = d.addr
  on conflict do nothing;

  -- Same person, street punctuation differs (853 E. vs 853 E)
  insert into public.possible_duplicate_voters (id)
  select v.id
  from public.voters v
  join (
    select
      public._given_name(first_name) as fn,
      lower(trim(last_name)) as ln,
      public._norm_address(address_line_1) as addr
    from public.voters
    where public._given_name(first_name) is not null
      and coalesce(trim(last_name), '') <> ''
      and public._norm_address(address_line_1) is not null
    group by 1, 2, 3
    having count(*) > 1
  ) d on public._given_name(v.first_name) = d.fn
    and lower(trim(v.last_name)) = d.ln
    and public._norm_address(v.address_line_1) = d.addr
  on conflict do nothing;

  -- Same email only if the name matches (household emails are not duplicates)
  insert into public.possible_duplicate_voters (id)
  select v.id
  from public.voters v
  join (
    select
      lower(trim(email)) as k,
      public._given_name(first_name) as fn,
      lower(trim(last_name)) as ln
    from public.voters
    where email is not null and length(trim(email)) >= 5
      and public._given_name(first_name) is not null
      and coalesce(trim(last_name), '') <> ''
    group by 1, 2, 3
    having count(*) > 1
  ) d on lower(trim(v.email)) = d.k
    and public._given_name(v.first_name) = d.fn
    and lower(trim(v.last_name)) = d.ln
  on conflict do nothing;

  -- Same phone only if the name matches (household landlines are not duplicates)
  insert into public.possible_duplicate_voters (id)
  select v.id
  from public.voters v
  join (
    select
      public._phone_digits(phone) as k,
      public._given_name(first_name) as fn,
      lower(trim(last_name)) as ln
    from public.voters
    where length(coalesce(public._phone_digits(phone), '')) >= 7
      and public._given_name(first_name) is not null
      and coalesce(trim(last_name), '') <> ''
    group by 1, 2, 3
    having count(*) > 1
  ) d on public._phone_digits(v.phone) = d.k
    and public._given_name(v.first_name) = d.fn
    and lower(trim(v.last_name)) = d.ln
  on conflict do nothing;

  -- Same Murmuration ID (case / whitespace variants)
  insert into public.possible_duplicate_voters (id)
  select v.id
  from public.voters v
  join (
    select lower(trim(murmuration_id)) as k
    from public.voters
    where coalesce(trim(murmuration_id), '') <> ''
    group by 1
    having count(*) > 1
  ) d on lower(trim(v.murmuration_id)) = d.k
  on conflict do nothing;

  -- Same voter ID on two rows
  insert into public.possible_duplicate_voters (id)
  select v.id
  from public.voters v
  join (
    select trim(voter_id) as k
    from public.voters
    where coalesce(trim(voter_id), '') <> ''
    group by 1
    having count(*) > 1
  ) d on trim(v.voter_id) = d.k
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

update public.possible_duplicate_state
set refreshed_at = null
where id = 1;

grant execute on function public._given_name(text) to service_role;
grant execute on function public.refresh_possible_duplicates() to service_role;
