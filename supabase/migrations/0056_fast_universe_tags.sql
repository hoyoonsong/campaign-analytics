-- Fast set-based tagging from universe any_of + signed (no per-row jsonb).

create or replace function public.recompute_supporter_tags()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '180s'
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
  has_any boolean;
  has_signed boolean;
  v_yard text[];
  v_donated text[];
  v_align text[];
  v_vol_int text[];
  v_news text[];
  v_attend text[];
  v_convo_sup text[];
  v_convo_st text[];
  v_convo_poll text[];
  v_topic text[];
  v_county text[];
  v_party text[];
  v_status text[];
  v_scores int[];
  want_vol boolean;
  want_donor boolean;
  want_attendee boolean;
  want_yard boolean;
  want_nl boolean;
begin
  update public.voters set supporter_tag = null where supporter_tag is not null;

  for u in
    select supporter_tag, filters, tag_priority
    from public.saved_voter_universes
    where nullif(trim(supporter_tag), '') is not null
    order by coalesce(tag_priority, 0) asc, updated_at asc
  loop
    f := coalesce(u.filters, '{}'::jsonb);
    any_of := case
      when jsonb_typeof(f->'any_of') = 'array' then f->'any_of'
      else '[]'::jsonb
    end;
    need_mask := public._petition_mask(public._jsonb_text_array(f, 'signed'));
    signed_min := nullif(f->>'signed_min', '')::int;
    signed_min_of := public._jsonb_text_array(f, 'signed_min_of');
    signed_min_mask := case
      when signed_min_of is not null then public._petition_mask(signed_min_of)
      else -1::bigint
    end;
    has_any := jsonb_array_length(any_of) > 0;
    has_signed := need_mask <> 0 or coalesce(signed_min, 0) > 0;
    if not has_any and not has_signed then
      continue;
    end if;

    select public._lower_text_array(array_agg(distinct lower(trim(x))))
    into v_yard
    from jsonb_array_elements(any_of) r,
         jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
    where lower(trim(r->>'field')) = 'yard_sign' and nullif(trim(x), '') is not null;

    select public._lower_text_array(array_agg(distinct lower(trim(x))))
    into v_donated
    from jsonb_array_elements(any_of) r,
         jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
    where lower(trim(r->>'field')) = 'donated' and nullif(trim(x), '') is not null;

    select public._lower_text_array(array_agg(distinct lower(trim(x))))
    into v_align
    from jsonb_array_elements(any_of) r,
         jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
    where lower(trim(r->>'field')) = 'alignment_label' and nullif(trim(x), '') is not null;

    select public._lower_text_array(array_agg(distinct lower(trim(x))))
    into v_vol_int
    from jsonb_array_elements(any_of) r,
         jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
    where lower(trim(r->>'field')) = 'volunteer_interest' and nullif(trim(x), '') is not null;

    select public._lower_text_array(array_agg(distinct lower(trim(x))))
    into v_news
    from jsonb_array_elements(any_of) r,
         jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
    where lower(trim(r->>'field')) = 'newsletter' and nullif(trim(x), '') is not null;

    select public._lower_text_array(array_agg(distinct lower(trim(x))))
    into v_attend
    from jsonb_array_elements(any_of) r,
         jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
    where lower(trim(r->>'field')) = 'attended_event' and nullif(trim(x), '') is not null;

    select public._lower_text_array(array_agg(distinct lower(trim(x))))
    into v_convo_sup
    from jsonb_array_elements(any_of) r,
         jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
    where lower(trim(r->>'field')) = 'convos_candidate_support' and nullif(trim(x), '') is not null;

    select public._lower_text_array(array_agg(distinct lower(trim(x))))
    into v_convo_st
    from jsonb_array_elements(any_of) r,
         jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
    where lower(trim(r->>'field')) = 'convos_contact_status' and nullif(trim(x), '') is not null;

    select public._lower_text_array(array_agg(distinct lower(trim(x))))
    into v_convo_poll
    from jsonb_array_elements(any_of) r,
         jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
    where lower(trim(r->>'field')) = 'convos_poll_question' and nullif(trim(x), '') is not null;

    select public._lower_text_array(array_agg(distinct lower(trim(x))))
    into v_topic
    from jsonb_array_elements(any_of) r,
         jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
    where lower(trim(r->>'field')) = 'top_main_topic' and nullif(trim(x), '') is not null;

    select public._lower_text_array(array_agg(distinct lower(trim(x))))
    into v_county
    from jsonb_array_elements(any_of) r,
         jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
    where lower(trim(r->>'field')) = 'county' and nullif(trim(x), '') is not null;

    select public._lower_text_array(array_agg(distinct lower(trim(x))))
    into v_party
    from jsonb_array_elements(any_of) r,
         jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
    where lower(trim(r->>'field')) = 'party' and nullif(trim(x), '') is not null;

    select public._lower_text_array(array_agg(distinct lower(trim(x))))
    into v_status
    from jsonb_array_elements(any_of) r,
         jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
    where lower(trim(r->>'field')) = 'status' and nullif(trim(x), '') is not null;

    begin
      select array_agg(distinct (trim(x))::int)
      into v_scores
      from jsonb_array_elements(any_of) r,
           jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
      where lower(trim(r->>'field')) = 'support_score' and nullif(trim(x), '') is not null;
    exception when others then
      v_scores := null;
    end;

    select exists (
      select 1
      from jsonb_array_elements(any_of) r,
           jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
      where lower(trim(r->>'field')) in ('campaign_volunteer', 'is_campaign_volunteer')
        and lower(trim(x)) in ('yes', 'y', 'true', '1')
    ) into want_vol;

    select exists (
      select 1
      from jsonb_array_elements(any_of) r,
           jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
      where lower(trim(r->>'field')) in ('campaign_donor', 'is_campaign_donor')
        and lower(trim(x)) in ('yes', 'y', 'true', '1')
    ) into want_donor;

    select exists (
      select 1
      from jsonb_array_elements(any_of) r,
           jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
      where lower(trim(r->>'field')) in ('campaign_attendee', 'is_campaign_attendee')
        and lower(trim(x)) in ('yes', 'y', 'true', '1')
    ) into want_attendee;

    select exists (
      select 1
      from jsonb_array_elements(any_of) r,
           jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
      where lower(trim(r->>'field')) in ('campaign_yard_sign', 'is_campaign_yard_sign')
        and lower(trim(x)) in ('yes', 'y', 'true', '1')
    ) into want_yard;

    select exists (
      select 1
      from jsonb_array_elements(any_of) r,
           jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
      where lower(trim(r->>'field')) in ('campaign_newsletter', 'is_campaign_newsletter')
        and lower(trim(x)) in ('yes', 'y', 'true', '1')
    ) into want_nl;

    update public.voters v
    set supporter_tag = trim(u.supporter_tag)
    where (need_mask = 0 or (v.signed_mask & need_mask) = need_mask)
      and (
        signed_min is null
        or signed_min <= 0
        or public._popcount(v.signed_mask & signed_min_mask) >= signed_min
      )
      and (
        not has_any
        or (
          (v_yard is not null and lower(coalesce(v.yard_sign, '')) = any (v_yard))
          or (v_donated is not null and lower(coalesce(v.donated, '')) = any (v_donated))
          or (v_align is not null and lower(coalesce(v.alignment_label, '')) = any (v_align))
          or (v_vol_int is not null and lower(coalesce(v.volunteer_interest, '')) = any (v_vol_int))
          or (v_news is not null and lower(coalesce(v.newsletter, '')) = any (v_news))
          or (v_attend is not null and lower(coalesce(v.attended_event, '')) = any (v_attend))
          or (v_convo_sup is not null and lower(coalesce(v.convos_candidate_support, '')) = any (v_convo_sup))
          or (v_convo_st is not null and lower(coalesce(v.convos_contact_status, '')) = any (v_convo_st))
          or (v_convo_poll is not null and lower(coalesce(v.convos_poll_question, '')) = any (v_convo_poll))
          or (v_topic is not null and lower(coalesce(v.top_main_topic, '')) = any (v_topic))
          or (v_county is not null and lower(coalesce(v.county, '')) = any (v_county))
          or (v_party is not null and lower(coalesce(v.party, '')) = any (v_party))
          or (v_status is not null and lower(coalesce(v.status, '')) = any (v_status))
          or (v_scores is not null and v.support_score = any (v_scores))
          or (want_vol and v.is_campaign_volunteer)
          or (want_donor and v.is_campaign_donor)
          or (want_attendee and v.is_campaign_attendee)
          or (want_yard and v.is_campaign_yard_sign)
          or (want_nl and v.is_campaign_newsletter)
        )
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

revoke all on function public.recompute_supporter_tags() from public;
grant execute on function public.recompute_supporter_tags() to service_role;
