-- mask × party totals for instant Target counts (same scan style as absentee_combos).

create or replace function public.absentee_mask_party(p_slugs text[] default null)
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
             lower(trim(coalesce(v.party, ''))) as party,
             count(*)::int as count
      from public.voters v
      where (v.absentee_mask & bits) <> 0
      group by 1, 2
    ) x
  ), '[]'::json);
end;
$$;

revoke all on function public.absentee_mask_party(text[]) from public;
grant execute on function public.absentee_mask_party(text[]) to service_role;
notify pgrst, 'reload schema';
