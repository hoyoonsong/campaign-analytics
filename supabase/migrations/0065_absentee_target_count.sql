-- Lean target-list count from voters.absentee_mask. Avoid per-row plpgsql.

create or replace function public.absentee_target_count(p_filters jsonb default '{}'::jsonb)
returns bigint
language sql
stable
security definer
set search_path = public
set jit = off
as $$
  with f as (
    select
      coalesce(public._absentee_mask(public._jsonb_text_array(p_filters, 'absentee_min_of')), 0) as habit_mask,
      coalesce(public._absentee_mask(public._jsonb_text_array(p_filters, 'exclude_absentee')), 0) as skip_mask,
      coalesce(nullif(p_filters->>'absentee_min', '')::int, 0) as min_n,
      public._lower_text_array(public._jsonb_text_array(p_filters, 'party')) as party,
      public._lower_text_array(public._jsonb_text_array(p_filters, 'county')) as county,
      public._lower_text_array(public._jsonb_text_array(p_filters, 'status')) as status,
      public._lower_text_array(public._jsonb_text_array(p_filters, 'alignment_label')) as alignment_label,
      public._lower_text_array(public._jsonb_text_array(p_filters, 'supporter_tag')) as supporter_tag,
      public._lower_text_array(public._jsonb_text_array(p_filters, 'exclude_party')) as exclude_party,
      public._lower_text_array(public._jsonb_text_array(p_filters, 'exclude_county')) as exclude_county,
      public._lower_text_array(public._jsonb_text_array(p_filters, 'exclude_status')) as exclude_status,
      public._lower_text_array(public._jsonb_text_array(p_filters, 'exclude_alignment_label')) as exclude_alignment,
      public._lower_text_array(public._jsonb_text_array(p_filters, 'exclude_supporter_tag')) as exclude_tag,
      nullif(p_filters->>'support_score_min', '')::int as support_min,
      nullif(p_filters->>'support_score_max', '')::int as support_max,
      nullif(p_filters->>'signed_any', '')::boolean as signed_any,
      nullif(p_filters->>'signed_min', '')::int as signed_min,
      coalesce(public._petition_mask(public._jsonb_text_array(p_filters, 'signed_min_of')), 0) as signed_min_mask,
      coalesce(public._petition_mask(public._jsonb_text_array(p_filters, 'exclude_signed')), 0) as exclude_signed_mask
  )
  select count(*)::bigint
  from public.voters v
  cross join f
  where v.absentee_mask <> 0
    and (f.skip_mask = 0 or (v.absentee_mask & f.skip_mask) = 0)
    and (f.min_n <= 0 or public._popcount(v.absentee_mask & f.habit_mask) >= f.min_n)
    and public._arr_match(v.party, f.party, false)
    and public._arr_match(v.county, f.county, false)
    and public._arr_match(v.status, f.status, false)
    and public._arr_match(v.alignment_label, f.alignment_label, false)
    and public._arr_match(v.supporter_tag, f.supporter_tag, false)
    and public._arr_match(v.party, f.exclude_party, true)
    and public._arr_match(v.county, f.exclude_county, true)
    and public._arr_match(v.status, f.exclude_status, true)
    and public._arr_match(v.alignment_label, f.exclude_alignment, true)
    and public._arr_match(v.supporter_tag, f.exclude_tag, true)
    and (f.support_min is null or v.support_score >= f.support_min)
    and (f.support_max is null or v.support_score <= f.support_max)
    and (f.signed_any is null or not f.signed_any or coalesce(v.signed_mask, 0) <> 0)
    and (
      f.signed_min is null
      or f.signed_min <= 0
      or public._popcount(coalesce(v.signed_mask, 0) & f.signed_min_mask) >= f.signed_min
    )
    and (f.exclude_signed_mask = 0 or (coalesce(v.signed_mask, 0) & f.exclude_signed_mask) = 0)
    and case
      when p_filters->'any_of' is null then true
      when jsonb_typeof(p_filters->'any_of') <> 'array' then true
      when jsonb_array_length(p_filters->'any_of') = 0 then true
      else public._voter_matches_any_of(v, p_filters->'any_of')
    end;
$$;

revoke all on function public.absentee_target_count(jsonb) from public;
grant execute on function public.absentee_target_count(jsonb) to service_role;
notify pgrst, 'reload schema';
