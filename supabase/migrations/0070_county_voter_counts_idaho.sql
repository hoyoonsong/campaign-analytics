-- 0069 grouped every distinct county string in the voter file (~1,500, including
-- out-of-state leftovers). The API stops at 1,000 rows, so some Idaho counties
-- came back as zero. Return one row per county that actually has a polling place.

create or replace function public.county_voter_counts()
returns table (county text, voters bigint)
language sql
stable
as $$
  select public._county_key(v.county) as county, count(*)::bigint
  from public.voters v
  where public._county_key(v.county) in (
    select distinct public._county_key(p.county)
    from public.polling_locations p
    where public._county_key(p.county) is not null
  )
  group by 1;
$$;

revoke all on function public.county_voter_counts() from public;
grant execute on function public.county_voter_counts() to service_role;
