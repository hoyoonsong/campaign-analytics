-- County sizes for the polling-gap page.

create or replace function public.county_voter_counts()
returns table (county text, voters bigint)
language sql
stable
as $$
  select coalesce(nullif(trim(county), ''), ''), count(*)::bigint
  from public.voters
  group by 1;
$$;

revoke all on function public.county_voter_counts() from public;
grant execute on function public.county_voter_counts() to service_role;
