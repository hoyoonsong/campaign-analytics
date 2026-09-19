-- Dashboard aggregates instead of shipping every ballot row.
-- The old json_agg payload timed out / overflowed, then the REST fallback
-- silently returned 1,000 rows (~200 unique people).

drop function if exists public.absentee_dashboard();
drop function if exists public.absentee_dashboard(text[]);

create or replace function public.absentee_dashboard(p_slugs text[] default null)
returns json
language plpgsql
stable
security definer
set search_path = public
set statement_timeout = '120s'
set jit = off
as $$
declare
  slugs text[];
begin
  slugs := case
    when p_slugs is null or cardinality(p_slugs) = 0 then null
    else p_slugs
  end;

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
    'by_county', coalesce((
      select json_agg(x)
      from (
        select
          coalesce(nullif(trim(v.county), ''), 'Unknown') as name,
          count(distinct b.voter_id)::int as count
        from public.voter_absentee_ballots b
        join public.absentee_elections e on e.id = b.election_id
        join public.voters v on v.id = b.voter_id
        where e.is_active
          and (slugs is null or e.slug = any (slugs))
        group by 1
        order by count(distinct b.voter_id) desc
        limit 12
      ) x
    ), '[]'::json),
    'by_party', coalesce((
      select json_agg(x)
      from (
        select
          case public._party_bucket(v.party)
            when 'republican' then 'Republican'
            when 'democrat' then 'Democrat'
            when 'independent' then 'Independent / other'
            else 'Unknown'
          end as name,
          count(distinct b.voter_id)::int as count
        from public.voter_absentee_ballots b
        join public.absentee_elections e on e.id = b.election_id
        join public.voters v on v.id = b.voter_id
        where e.is_active
          and (slugs is null or e.slug = any (slugs))
        group by 1
        order by count(distinct b.voter_id) desc
      ) x
    ), '[]'::json),
    'petition_overlap', coalesce((
      select json_agg(x)
      from (
        select
          p.slug,
          p.label,
          p.bit_index,
          count(*)::int as count
        from (
          select distinct b.voter_id, v.signed_mask
          from public.voter_absentee_ballots b
          join public.absentee_elections e on e.id = b.election_id
          join public.voters v on v.id = b.voter_id
          where e.is_active
            and (slugs is null or e.slug = any (slugs))
        ) av
        join public.petitions p
          on p.is_active
          and (coalesce(av.signed_mask, 0) & (1::bigint << p.bit_index)) <> 0
        group by p.slug, p.label, p.bit_index, p.sort_order
        order by p.sort_order, p.slug
      ) x
    ), '[]'::json)
  );
end;
$$;

revoke all on function public.absentee_dashboard(text[]) from public;
grant execute on function public.absentee_dashboard(text[]) to service_role;
