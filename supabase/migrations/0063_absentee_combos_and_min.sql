-- Combination counts for the absentee Venn, plus absentee_min / absentee_min_of
-- so a year-group click can mean "any ballot in that year".

create or replace function public.absentee_combos(p_slugs text[] default null)
returns json
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  slugs text[];
  bits bigint;
begin
  slugs := case
    when p_slugs is null or cardinality(p_slugs) = 0 then null
    else p_slugs
  end;

  select coalesce(bit_or(1::bigint << e.bit_index), 0)
  into bits
  from public.absentee_elections e
  where e.is_active
    and (slugs is null or e.slug = any (slugs));

  if bits is null or bits = 0 then
    return '[]'::json;
  end if;

  return coalesce((
    select json_agg(x)
    from (
      select (v.absentee_mask & bits)::bigint as mask,
             count(*)::int as count
      from public.voters v
      where (v.absentee_mask & bits) <> 0
      group by 1
      order by count(*) desc
    ) x
  ), '[]'::json);
end;
$$;

revoke all on function public.absentee_combos(text[]) from public;
grant execute on function public.absentee_combos(text[]) to service_role;

create or replace function public._filters_have_absentee(f jsonb)
returns boolean
language sql
immutable
as $$
  select
    coalesce(jsonb_typeof(f->'absentee'), 'null') = 'array'
      and jsonb_array_length(f->'absentee') > 0
    or coalesce(jsonb_typeof(f->'absentee_status'), 'null') = 'array'
      and jsonb_array_length(f->'absentee_status') > 0
    or coalesce(jsonb_typeof(f->'exclude_absentee'), 'null') = 'array'
      and jsonb_array_length(f->'exclude_absentee') > 0
    or coalesce(jsonb_typeof(f->'exclude_absentee_status'), 'null') = 'array'
      and jsonb_array_length(f->'exclude_absentee_status') > 0
    or coalesce(nullif(f->>'absentee_min', '')::int, 0) > 0;
$$;

create or replace function public._voter_matches_absentee(v public.voters, filters jsonb)
returns boolean
language plpgsql
stable
as $$
declare
  f jsonb := coalesce(filters, '{}'::jsonb);
  want_slugs text[];
  excl_slugs text[];
  want_status text[];
  excl_status text[];
  need_mask bigint;
  excl_mask bigint;
  min_n int;
  min_of text[];
  min_mask bigint;
  status_ok boolean;
  excl_status_hit boolean;
begin
  if not public._filters_have_absentee(f) then
    return true;
  end if;

  want_slugs := public._jsonb_text_array(f, 'absentee');
  excl_slugs := public._jsonb_text_array(f, 'exclude_absentee');
  want_status := public._jsonb_text_array(f, 'absentee_status');
  excl_status := public._jsonb_text_array(f, 'exclude_absentee_status');
  need_mask := public._absentee_mask(want_slugs);
  excl_mask := public._absentee_mask(excl_slugs);
  min_n := coalesce(nullif(f->>'absentee_min', '')::int, 0);
  min_of := public._jsonb_text_array(f, 'absentee_min_of');
  min_mask := case
    when min_of is not null then public._absentee_mask(min_of)
    else (
      select coalesce(bit_or(1::bigint << e.bit_index), 0)
      from public.absentee_elections e
      where e.is_active
    )
  end;

  if need_mask <> 0 and (coalesce(v.absentee_mask, 0) & need_mask) <> need_mask then
    return false;
  end if;
  if excl_mask <> 0 and (coalesce(v.absentee_mask, 0) & excl_mask) <> 0 then
    return false;
  end if;
  if min_n > 0 and public._popcount(coalesce(v.absentee_mask, 0) & min_mask) < min_n then
    return false;
  end if;

  if want_status is not null then
    select exists (
      select 1
      from public.voter_absentee_ballots b
      join public.absentee_elections e on e.id = b.election_id
      where b.voter_id = v.id
        and b.status = any (want_status)
        and (
          want_slugs is null
          or e.slug = any (want_slugs)
        )
    ) into status_ok;
    if not status_ok then
      return false;
    end if;
  end if;

  if excl_status is not null then
    select exists (
      select 1
      from public.voter_absentee_ballots b
      join public.absentee_elections e on e.id = b.election_id
      where b.voter_id = v.id
        and b.status = any (excl_status)
        and (
          excl_slugs is null
          or e.slug = any (excl_slugs)
        )
    ) into excl_status_hit;
    if excl_status_hit then
      return false;
    end if;
  end if;

  return true;
end;
$$;

notify pgrst, 'reload schema';
