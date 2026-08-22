-- One sequential scan to apply tagged universes (priority high → first CASE).

create or replace function public._sql_text_any(arr text[])
returns text
language sql
immutable
as $$
  select 'ARRAY[' || coalesce((
    select string_agg(quote_literal(lower(trim(x))), ',')
    from unnest(arr) x
    where nullif(trim(x), '') is not null
  ), '') || ']::text[]';
$$;

create or replace function public._universe_or_pred(filters jsonb)
returns text
language plpgsql
stable
as $$
declare
  f jsonb := coalesce(filters, '{}'::jsonb);
  any_of jsonb := case
    when jsonb_typeof(f->'any_of') = 'array' then f->'any_of'
    else '[]'::jsonb
  end;
  clauses text[] := '{}';
  need_mask bigint;
  signed_min int;
  signed_min_of text[];
  signed_min_mask bigint;
  pred text;
  vals text[];
  nums int[];
  field text;
  r jsonb;
begin
  for r in select value from jsonb_array_elements(any_of)
  loop
    field := lower(trim(coalesce(r->>'field', '')));
    if field = 'support_score' then
      begin
        nums := array(
          select (trim(x))::int
          from jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) x
          where nullif(trim(x), '') is not null
        );
      exception when others then
        nums := null;
      end;
      if nums is not null and cardinality(nums) > 0 then
        clauses := array_append(clauses, format(
          'v.support_score = any (%s::int[])',
          'ARRAY[' || (select string_agg(n::text, ',') from unnest(nums) n) || ']'
        ));
      end if;
      continue;
    end if;

    vals := public._lower_text_array(public._jsonb_text_array(r, 'values'));
    if vals is null or cardinality(vals) = 0 then
      continue;
    end if;

    if field = 'yard_sign' then
      clauses := array_append(clauses, format(
        'lower(coalesce(v.yard_sign, '''')) = any (%s)',
        public._sql_text_any(vals)
      ));
    elsif field = 'donated' then
      clauses := array_append(clauses, format(
        'lower(coalesce(v.donated, '''')) = any (%s)',
        public._sql_text_any(vals)
      ));
    elsif field = 'alignment_label' then
      clauses := array_append(clauses, format(
        'lower(coalesce(v.alignment_label, '''')) = any (%s)',
        public._sql_text_any(vals)
      ));
    elsif field = 'volunteer_interest' then
      clauses := array_append(clauses, format(
        'lower(coalesce(v.volunteer_interest, '''')) = any (%s)',
        public._sql_text_any(vals)
      ));
    elsif field = 'newsletter' then
      clauses := array_append(clauses, format(
        'lower(coalesce(v.newsletter, '''')) = any (%s)',
        public._sql_text_any(vals)
      ));
    elsif field = 'attended_event' then
      clauses := array_append(clauses, format(
        'lower(coalesce(v.attended_event, '''')) = any (%s)',
        public._sql_text_any(vals)
      ));
    elsif field = 'convos_candidate_support' then
      clauses := array_append(clauses, format(
        'lower(coalesce(v.convos_candidate_support, '''')) = any (%s)',
        public._sql_text_any(vals)
      ));
    elsif field = 'convos_contact_status' then
      clauses := array_append(clauses, format(
        'lower(coalesce(v.convos_contact_status, '''')) = any (%s)',
        public._sql_text_any(vals)
      ));
    elsif field = 'convos_poll_question' then
      clauses := array_append(clauses, format(
        'lower(coalesce(v.convos_poll_question, '''')) = any (%s)',
        public._sql_text_any(vals)
      ));
    elsif field = 'top_main_topic' then
      clauses := array_append(clauses, format(
        'lower(coalesce(v.top_main_topic, '''')) = any (%s)',
        public._sql_text_any(vals)
      ));
    elsif field = 'county' then
      clauses := array_append(clauses, format(
        'lower(coalesce(v.county, '''')) = any (%s)',
        public._sql_text_any(vals)
      ));
    elsif field = 'party' then
      clauses := array_append(clauses, format(
        'lower(coalesce(v.party, '''')) = any (%s)',
        public._sql_text_any(vals)
      ));
    elsif field = 'status' then
      clauses := array_append(clauses, format(
        'lower(coalesce(v.status, '''')) = any (%s)',
        public._sql_text_any(vals)
      ));
    elsif field in ('campaign_volunteer', 'is_campaign_volunteer')
      and public._any_of_yes(vals) then
      clauses := array_append(clauses, 'v.is_campaign_volunteer');
    elsif field in ('campaign_donor', 'is_campaign_donor')
      and public._any_of_yes(vals) then
      clauses := array_append(clauses, 'v.is_campaign_donor');
    elsif field in ('campaign_attendee', 'is_campaign_attendee')
      and public._any_of_yes(vals) then
      clauses := array_append(clauses, 'v.is_campaign_attendee');
    elsif field in ('campaign_yard_sign', 'is_campaign_yard_sign')
      and public._any_of_yes(vals) then
      clauses := array_append(clauses, 'v.is_campaign_yard_sign');
    elsif field in ('campaign_newsletter', 'is_campaign_newsletter')
      and public._any_of_yes(vals) then
      clauses := array_append(clauses, 'v.is_campaign_newsletter');
    end if;
  end loop;

  pred := case
    when cardinality(clauses) = 0 then 'true'
    else '(' || array_to_string(clauses, ' or ') || ')'
  end;

  need_mask := public._petition_mask(public._jsonb_text_array(f, 'signed'));
  signed_min := nullif(f->>'signed_min', '')::int;
  signed_min_of := public._jsonb_text_array(f, 'signed_min_of');
  signed_min_mask := case
    when signed_min_of is not null then public._petition_mask(signed_min_of)
    else -1::bigint
  end;

  if need_mask <> 0 then
    pred := format('(%s) and (v.signed_mask & %s::bigint) = %s::bigint', pred, need_mask, need_mask);
  end if;
  if coalesce(signed_min, 0) > 0 then
    pred := format(
      '(%s) and public._popcount(v.signed_mask & %s::bigint) >= %s',
      pred, signed_min_mask, signed_min
    );
  end if;

  if cardinality(clauses) = 0 and need_mask = 0 and coalesce(signed_min, 0) <= 0 then
    return null;
  end if;
  return pred;
end;
$$;

create or replace function public.recompute_supporter_tags()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '180s'
as $$
declare
  u record;
  parts text := '';
  pred text;
  n_univ int := 0;
  sql text;
begin
  for u in
    select supporter_tag, filters, tag_priority
    from public.saved_voter_universes
    where nullif(trim(supporter_tag), '') is not null
    order by coalesce(tag_priority, 0) desc, updated_at desc
  loop
    pred := public._universe_or_pred(coalesce(u.filters, '{}'::jsonb));
    if pred is null then
      continue;
    end if;
    parts := parts || format(' when (%s) then %L ', pred, trim(u.supporter_tag));
    n_univ := n_univ + 1;
  end loop;

  if parts = '' then
    sql := $q$
      update public.voters v
      set supporter_tag = case
        when lower(coalesce(v.yard_sign, '')) in ('yes', 'delivered')
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
          or v.is_campaign_newsletter
          then 'supporter'
        when lower(coalesce(v.convos_candidate_support, '')) = 'no'
          or lower(coalesce(v.alignment_label, '')) = 'negative'
          or v.support_score in (4, 5)
          then 'opposed'
        when lower(coalesce(v.alignment_label, '')) = 'neutral'
          or lower(coalesce(v.convos_candidate_support, '')) = 'maybe'
          or lower(coalesce(v.convos_poll_question, '')) = 'c) not sure'
          or v.support_score = 3
          then 'maybe'
        else null
      end
      where supporter_tag is distinct from (
        case
          when lower(coalesce(v.yard_sign, '')) in ('yes', 'delivered')
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
            or v.is_campaign_newsletter
            then 'supporter'
          when lower(coalesce(v.convos_candidate_support, '')) = 'no'
            or lower(coalesce(v.alignment_label, '')) = 'negative'
            or v.support_score in (4, 5)
            then 'opposed'
          when lower(coalesce(v.alignment_label, '')) = 'neutral'
            or lower(coalesce(v.convos_candidate_support, '')) = 'maybe'
            or lower(coalesce(v.convos_poll_question, '')) = 'c) not sure'
            or v.support_score = 3
            then 'maybe'
          else null
        end
      )
    $q$;
  else
    sql := format(
      'update public.voters v set supporter_tag = case %s else null end
       where supporter_tag is distinct from (case %s else null end)',
      parts, parts
    );
  end if;

  execute sql;

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

revoke all on function public._sql_text_any(text[]) from public;
revoke all on function public._universe_or_pred(jsonb) from public;
revoke all on function public.recompute_supporter_tags() from public;
grant execute on function public.recompute_supporter_tags() to service_role;
