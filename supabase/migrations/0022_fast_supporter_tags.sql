-- Fast set-based supporter tags + indexed tag filter (stop timeout any_of scans).
-- Also tighten nearby geo helper to require coordinates first.

create or replace function public.recompute_supporter_tags()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_maybe int := 0;
  n_opposed int := 0;
  n_supporter int := 0;
begin
  perform set_config('statement_timeout', '120s', true);

  update public.voters set supporter_tag = null where supporter_tag is not null;

  -- Priority order: maybe (10) → opposed (20) → supporter (30). Later overwrites.
  update public.voters v
  set supporter_tag = 'maybe'
  where
    lower(coalesce(v.alignment_label, '')) = 'neutral'
    or lower(coalesce(v.convos_candidate_support, '')) = 'maybe'
    or lower(coalesce(v.convos_poll_question, '')) = 'c) not sure'
    or v.support_score = 3;
  get diagnostics n_maybe = row_count;

  update public.voters v
  set supporter_tag = 'opposed'
  where
    lower(coalesce(v.convos_candidate_support, '')) = 'no'
    or lower(coalesce(v.alignment_label, '')) = 'negative'
    or v.support_score in (4, 5);
  get diagnostics n_opposed = row_count;

  update public.voters v
  set supporter_tag = 'supporter'
  where
    lower(coalesce(v.yard_sign, '')) in ('yes', 'delivered')
    or lower(coalesce(v.donated, '')) = 'yes'
    or lower(coalesce(v.alignment_label, '')) = 'positive'
    or v.support_score in (1, 2)
    or lower(coalesce(v.convos_candidate_support, '')) = 'yes';
  get diagnostics n_supporter = row_count;

  return jsonb_build_object(
    'maybe', n_maybe,
    'opposed', n_opposed,
    'supporter', n_supporter,
    'tagged_voters', (select count(*)::int from public.voters where supporter_tag is not null)
  );
end;
$$;

revoke all on function public.recompute_supporter_tags() from public;
grant execute on function public.recompute_supporter_tags() to service_role;

create index if not exists voters_supporter_tag_lower_idx
  on public.voters (lower(supporter_tag))
  where supporter_tag is not null and supporter_tag <> '';

-- Faster nearby: short-circuit null coords before scanning geo pins.
create or replace function public._has_nearby_geo(
  p_lat double precision,
  p_lng double precision,
  p_kind text,
  p_max_miles double precision
)
returns boolean
language sql
stable
as $$
  select case
    when p_lat is null or p_lng is null or p_max_miles is null or p_max_miles <= 0 then false
    else exists (
      select 1
      from public.campaign_geo_points g
      where g.kind = p_kind
        and g.lat between p_lat - (p_max_miles / 69.0)
                      and p_lat + (p_max_miles / 69.0)
        and g.lng between p_lng - (p_max_miles / (69.0 * greatest(cos(radians(p_lat)), 0.2)))
                      and p_lng + (p_max_miles / (69.0 * greatest(cos(radians(p_lat)), 0.2)))
        and public._miles_between(p_lat, p_lng, g.lat, g.lng) <= p_max_miles
      limit 1
    )
  end;
$$;

-- Materialize tags now (free-tier safe set updates).
select public.recompute_supporter_tags();
