-- Fast absentee dashboard: ballot-only status counts + voters.absentee_mask
-- for demographics. The 0061 version joined ballots to voters four times
-- (~12s) and the API aborted, so the page cached zeros.

drop function if exists public.absentee_dashboard();
drop function if exists public.absentee_dashboard(text[]);

create or replace function public.absentee_dashboard(p_slugs text[] default null)
returns json
language plpgsql
stable
security definer
set search_path = public
set statement_timeout = '60s'
set jit = off
as $$
declare
  slugs text[];
  by_county json;
  by_party json;
  overlap json;
begin
  slugs := case
    when p_slugs is null or cardinality(p_slugs) = 0 then null
    else p_slugs
  end;

  if slugs is null then
    select coalesce(json_agg(x), '[]'::json) into by_county
    from (
      select
        coalesce(nullif(trim(v.county), ''), 'Unknown') as name,
        count(*)::int as count
      from public.voters v
      where v.absentee_mask <> 0
      group by 1
      order by count(*) desc
      limit 12
    ) x;

    select coalesce(json_agg(x), '[]'::json) into by_party
    from (
      select
        case public._party_bucket(v.party)
          when 'republican' then 'Republican'
          when 'democrat' then 'Democrat'
          when 'independent' then 'Independent / other'
          else 'Unknown'
        end as name,
        count(*)::int as count
      from public.voters v
      where v.absentee_mask <> 0
      group by 1
      order by count(*) desc
    ) x;

    select coalesce(json_agg(x), '[]'::json) into overlap
    from (
      select
        p.slug,
        p.label,
        p.bit_index,
        count(*)::int as count
      from public.voters v
      join public.petitions p
        on p.is_active
        and (coalesce(v.signed_mask, 0) & (1::bigint << p.bit_index)) <> 0
      where v.absentee_mask <> 0
      group by p.slug, p.label, p.bit_index, p.sort_order
      order by p.sort_order, p.slug
    ) x;
  else
    select coalesce(json_agg(x), '[]'::json) into by_county
    from (
      select
        coalesce(nullif(trim(v.county), ''), 'Unknown') as name,
        count(*)::int as count
      from (
        select distinct b.voter_id
        from public.voter_absentee_ballots b
        join public.absentee_elections e on e.id = b.election_id
        where e.is_active and e.slug = any (slugs)
      ) av
      join public.voters v on v.id = av.voter_id
      group by 1
      order by count(*) desc
      limit 12
    ) x;

    select coalesce(json_agg(x), '[]'::json) into by_party
    from (
      select
        case public._party_bucket(v.party)
          when 'republican' then 'Republican'
          when 'democrat' then 'Democrat'
          when 'independent' then 'Independent / other'
          else 'Unknown'
        end as name,
        count(*)::int as count
      from (
        select distinct b.voter_id
        from public.voter_absentee_ballots b
        join public.absentee_elections e on e.id = b.election_id
        where e.is_active and e.slug = any (slugs)
      ) av
      join public.voters v on v.id = av.voter_id
      group by 1
      order by count(*) desc
    ) x;

    select coalesce(json_agg(x), '[]'::json) into overlap
    from (
      select
        p.slug,
        p.label,
        p.bit_index,
        count(*)::int as count
      from (
        select distinct b.voter_id
        from public.voter_absentee_ballots b
        join public.absentee_elections e on e.id = b.election_id
        where e.is_active and e.slug = any (slugs)
      ) av
      join public.voters v on v.id = av.voter_id
      join public.petitions p
        on p.is_active
        and (coalesce(v.signed_mask, 0) & (1::bigint << p.bit_index)) <> 0
      group by p.slug, p.label, p.bit_index, p.sort_order
      order by p.sort_order, p.slug
    ) x;
  end if;

  return json_build_object(
    'elections', coalesce((
      select json_agg(e)
      from (
        select id, slug, label, short_label, bit_index, sort_order,
               is_default, is_active, created_at
        from public.absentee_elections
        order by sort_order, slug
      ) e
    ), '[]'::json),
    'headline', (
      select json_build_object(
        'unique_voters', count(distinct b.voter_id)::int,
        'rows', count(*)::int,
        'requested_not_returned', count(*) filter (
          where b.status in ('REQUESTED', 'ISSUED', 'MAILED')
        )::int,
        'returned', count(*) filter (
          where b.status in ('RETURNED', 'ACCEPTED')
        )::int,
        'accepted', count(*) filter (where b.status = 'ACCEPTED')::int,
        'rejected', count(*) filter (where b.status = 'REJECTED')::int
      )
      from public.voter_absentee_ballots b
      join public.absentee_elections e on e.id = b.election_id
      where e.is_active
        and (slugs is null or e.slug = any (slugs))
    ),
    'by_election', coalesce((
      select json_agg(x)
      from (
        select
          e.id,
          e.slug,
          e.label,
          e.short_label,
          count(distinct b.voter_id)::int as unique_voters,
          count(*) filter (where b.status = 'REQUESTED')::int as "REQUESTED",
          count(*) filter (where b.status = 'ISSUED')::int as "ISSUED",
          count(*) filter (where b.status = 'MAILED')::int as "MAILED",
          count(*) filter (where b.status = 'RETURNED')::int as "RETURNED",
          count(*) filter (where b.status = 'ACCEPTED')::int as "ACCEPTED",
          count(*) filter (where b.status = 'REJECTED')::int as "REJECTED",
          count(*) filter (where b.status = 'CANCELLED')::int as "CANCELLED",
          count(*) filter (where b.status = 'UNKNOWN')::int as "UNKNOWN"
        from public.absentee_elections e
        left join public.voter_absentee_ballots b on b.election_id = e.id
        where e.is_active
          and (slugs is null or e.slug = any (slugs))
        group by e.id, e.slug, e.label, e.short_label, e.sort_order
        order by e.sort_order, e.slug
      ) x
    ), '[]'::json),
    'by_county', coalesce(by_county, '[]'::json),
    'by_party', coalesce(by_party, '[]'::json),
    'petition_overlap', coalesce(overlap, '[]'::json)
  );
end;
$$;

revoke all on function public.absentee_dashboard(text[]) from public;
grant execute on function public.absentee_dashboard(text[]) to service_role;

notify pgrst, 'reload schema';
