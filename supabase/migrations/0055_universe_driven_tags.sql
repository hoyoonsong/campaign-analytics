-- Tag voters from saved universes (so Edit universe updates Analytics).
-- Set-based any_of + signed; invalidate analytics cache after tagging.

alter table public.voters
  add column if not exists is_campaign_donor boolean not null default false,
  add column if not exists is_campaign_attendee boolean not null default false,
  add column if not exists is_campaign_yard_sign boolean not null default false,
  add column if not exists is_campaign_newsletter boolean not null default false;

create or replace function public._any_of_yes(vals text[])
returns boolean
language sql
immutable
parallel safe
as $$
  select vals is not null and exists (
    select 1
    from unnest(vals) as x
    where lower(trim(x)) in ('yes', 'y', 'true', '1')
  );
$$;

create or replace function public._any_of_hit(v public.voters, rules jsonb)
returns boolean
language sql
stable
as $$
  select case
    when rules is null
      or jsonb_typeof(rules) <> 'array'
      or jsonb_array_length(rules) = 0 then true
    else exists (
      select 1
      from jsonb_array_elements(rules) r
      where case lower(trim(coalesce(r->>'field', '')))
        when 'support_score' then
          v.support_score is not null
          and exists (
            select 1
            from jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
            where nullif(trim(x), '') is not null
              and v.support_score = (trim(x))::int
          )
        when 'yard_sign' then
          lower(coalesce(v.yard_sign, ''))
            = any (public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'donated' then
          lower(coalesce(v.donated, ''))
            = any (public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'alignment_label' then
          lower(coalesce(v.alignment_label, ''))
            = any (public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'volunteer_interest' then
          lower(coalesce(v.volunteer_interest, ''))
            = any (public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'newsletter' then
          lower(coalesce(v.newsletter, ''))
            = any (public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'attended_event' then
          lower(coalesce(v.attended_event, ''))
            = any (public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'convos_candidate_support' then
          lower(coalesce(v.convos_candidate_support, ''))
            = any (public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'convos_contact_status' then
          lower(coalesce(v.convos_contact_status, ''))
            = any (public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'convos_poll_question' then
          lower(coalesce(v.convos_poll_question, ''))
            = any (public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'top_main_topic' then
          lower(coalesce(v.top_main_topic, ''))
            = any (public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'county' then
          lower(coalesce(v.county, ''))
            = any (public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'party' then
          lower(coalesce(v.party, ''))
            = any (public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'status' then
          lower(coalesce(v.status, ''))
            = any (public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'campaign_volunteer' then
          v.is_campaign_volunteer
          and public._any_of_yes(public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'is_campaign_volunteer' then
          v.is_campaign_volunteer
          and public._any_of_yes(public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'campaign_donor' then
          v.is_campaign_donor
          and public._any_of_yes(public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'campaign_attendee' then
          v.is_campaign_attendee
          and public._any_of_yes(public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'campaign_yard_sign' then
          v.is_campaign_yard_sign
          and public._any_of_yes(public._lower_text_array(public._jsonb_text_array(r, 'values')))
        when 'campaign_newsletter' then
          v.is_campaign_newsletter
          and public._any_of_yes(public._lower_text_array(public._jsonb_text_array(r, 'values')))
        else false
      end
    )
  end;
$$;

create or replace function public.recompute_supporter_tags()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
as $$
declare
  u record;
  n_univ int := 0;
  f jsonb;
  any_of jsonb;
  need_mask bigint;
  signed_min int;
  signed_min_mask bigint;
  signed_min_of text[];
  has_rule boolean;
begin
  update public.voters set supporter_tag = null where supporter_tag is not null;

  for u in
    select supporter_tag, filters, tag_priority
    from public.saved_voter_universes
    where nullif(trim(supporter_tag), '') is not null
    order by coalesce(tag_priority, 0) asc, updated_at asc
  loop
    f := coalesce(u.filters, '{}'::jsonb);
    any_of := f->'any_of';
    need_mask := public._petition_mask(public._jsonb_text_array(f, 'signed'));
    signed_min := nullif(f->>'signed_min', '')::int;
    signed_min_of := public._jsonb_text_array(f, 'signed_min_of');
    signed_min_mask := case
      when signed_min_of is not null then public._petition_mask(signed_min_of)
      else -1::bigint
    end;

    has_rule :=
      (any_of is not null and jsonb_typeof(any_of) = 'array' and jsonb_array_length(any_of) > 0)
      or need_mask <> 0
      or coalesce(signed_min, 0) > 0;
    if not has_rule then
      continue;
    end if;

    update public.voters v
    set supporter_tag = trim(u.supporter_tag)
    where public._any_of_hit(v, any_of)
      and (need_mask = 0 or (v.signed_mask & need_mask) = need_mask)
      and (
        signed_min is null
        or signed_min <= 0
        or public._popcount(v.signed_mask & signed_min_mask) >= signed_min
      );

    n_univ := n_univ + 1;
  end loop;

  if n_univ = 0 then
    update public.voters v
    set supporter_tag = 'maybe'
    where
      lower(coalesce(v.alignment_label, '')) = 'neutral'
      or lower(coalesce(v.convos_candidate_support, '')) = 'maybe'
      or lower(coalesce(v.convos_poll_question, '')) = 'c) not sure'
      or v.support_score = 3;

    update public.voters v
    set supporter_tag = 'opposed'
    where
      lower(coalesce(v.convos_candidate_support, '')) = 'no'
      or lower(coalesce(v.alignment_label, '')) = 'negative'
      or v.support_score in (4, 5);

    update public.voters v
    set supporter_tag = 'supporter'
    where
      lower(coalesce(v.yard_sign, '')) in ('yes', 'delivered')
      or lower(coalesce(v.donated, '')) = 'yes'
      or lower(coalesce(v.alignment_label, '')) = 'positive'
      or v.support_score in (1, 2)
      or lower(coalesce(v.convos_candidate_support, '')) = 'yes'
      or lower(coalesce(v.volunteer_interest, '')) in ('yes', 'y')
      or lower(coalesce(v.attended_event, '')) in ('yes', 'y')
      or lower(coalesce(v.newsletter, '')) in ('yes', 'y')
      or v.is_campaign_volunteer
      or v.is_campaign_donor
      or v.is_campaign_attendee
      or v.is_campaign_yard_sign
      or v.is_campaign_newsletter;
  end if;

  -- Stale Analytics cache still has old supporter / maybe / opposed counts.
  update public.campaign_sync_state
  set
    analytics_summary_cache = null,
    analytics_summary_cached_at = null,
    updated_at = now()
  where id = 1;

  return jsonb_build_object(
    'universes_applied', n_univ,
    'tagged_voters', (
      select count(*)::int from public.voters where supporter_tag is not null
    ),
    'supporter', (
      select count(*)::int from public.voters where lower(trim(supporter_tag)) = 'supporter'
    ),
    'maybe', (
      select count(*)::int from public.voters where lower(trim(supporter_tag)) = 'maybe'
    ),
    'opposed', (
      select count(*)::int from public.voters where lower(trim(supporter_tag)) = 'opposed'
    )
  );
end;
$$;

revoke all on function public._any_of_yes(text[]) from public;
revoke all on function public._any_of_hit(public.voters, jsonb) from public;
revoke all on function public.recompute_supporter_tags() from public;
grant execute on function public.recompute_supporter_tags() to service_role;
