-- Cross-field OR rules: filters.any_of = [{ field, values }, ...]
-- Combined with existing AND filters (petitions, geo, exclude, nearby).

create or replace function public._voter_matches_any_of(
  v public.voters,
  rules jsonb
)
returns boolean
language plpgsql
stable
as $$
declare
  r jsonb;
  field text;
  vals text[];
  nums int[];
begin
  if rules is null
     or jsonb_typeof(rules) <> 'array'
     or jsonb_array_length(rules) = 0 then
    return true;
  end if;

  for r in select value from jsonb_array_elements(rules) as t(value)
  loop
    field := lower(trim(coalesce(r->>'field', '')));

    if field = 'support_score' then
      begin
        nums := array(
          select (x)::int
          from jsonb_array_elements_text(coalesce(r->'values', '[]'::jsonb)) as x
          where nullif(trim(x), '') is not null
        );
      exception when others then
        nums := null;
      end;
      if nums is not null
         and cardinality(nums) > 0
         and v.support_score is not null
         and v.support_score = any (nums) then
        return true;
      end if;
      continue;
    end if;

    vals := public._lower_text_array(public._jsonb_text_array(r, 'values'));
    if vals is null or cardinality(vals) = 0 then
      continue;
    end if;

    if field = 'yard_sign' and lower(coalesce(v.yard_sign, '')) = any (vals) then
      return true;
    elsif field = 'donated' and lower(coalesce(v.donated, '')) = any (vals) then
      return true;
    elsif field = 'alignment_label' and lower(coalesce(v.alignment_label, '')) = any (vals) then
      return true;
    elsif field = 'volunteer_interest' and lower(coalesce(v.volunteer_interest, '')) = any (vals) then
      return true;
    elsif field = 'newsletter' and lower(coalesce(v.newsletter, '')) = any (vals) then
      return true;
    elsif field = 'attended_event' and lower(coalesce(v.attended_event, '')) = any (vals) then
      return true;
    elsif field = 'convos_candidate_support'
      and lower(coalesce(v.convos_candidate_support, '')) = any (vals) then
      return true;
    elsif field = 'convos_contact_status'
      and lower(coalesce(v.convos_contact_status, '')) = any (vals) then
      return true;
    elsif field = 'convos_poll_question'
      and lower(coalesce(v.convos_poll_question, '')) = any (vals) then
      return true;
    elsif field = 'top_main_topic' and lower(coalesce(v.top_main_topic, '')) = any (vals) then
      return true;
    elsif field = 'county' and lower(coalesce(v.county, '')) = any (vals) then
      return true;
    elsif field = 'party' and lower(coalesce(v.party, '')) = any (vals) then
      return true;
    elsif field = 'status' and lower(coalesce(v.status, '')) = any (vals) then
      return true;
    end if;
  end loop;

  return false;
end;
$$;

-- Patch matcher: keep 0015 body + any_of AND.
create or replace function public.voters_match_filters(v public.voters, filters jsonb)
returns boolean
language plpgsql
stable
as $$
declare
  f jsonb := coalesce(filters, '{}'::jsonb);
  f_county text[]; f_party text[]; f_city text[]; f_zip text[]; f_status text[];
  x_county text[]; x_party text[]; x_city text[]; x_zip text[]; x_status text[];
  f_age_min int; f_age_max int; f_support_min int; f_support_max int;
  x_age_min int; x_age_max int; x_support_min int; x_support_max int;
  f_has_coords boolean; f_signed text[]; x_signed text[];
  f_signed_any boolean; f_signed_all_core boolean;
  f_alignment text[]; f_yard text[]; f_volunteer text[]; f_newsletter text[];
  f_donated text[]; f_attended text[]; f_topic text[]; f_convos_support text[]; f_convos_status text[];
  x_alignment text[]; x_yard text[]; x_volunteer text[]; x_newsletter text[];
  x_donated text[]; x_attended text[]; x_topic text[]; x_convos_support text[]; x_convos_status text[];
  f_has_volunteer boolean; f_has_yard boolean; f_has_donated boolean;
  x_has_volunteer boolean; x_has_yard boolean; x_has_donated boolean;
  x_campaign_volunteer boolean;
  f_nearby_yard double precision; f_nearby_vol double precision;
  need_open boolean; need_repro boolean; need_achilles boolean; need_mmj boolean;
  x_open boolean; x_repro boolean; x_achilles boolean; x_mmj boolean;
  age_val int;
begin
  f_county := public._lower_text_array(public._jsonb_text_array(f, 'county'));
  f_party := public._lower_text_array(public._jsonb_text_array(f, 'party'));
  f_city := public._lower_text_array(public._jsonb_text_array(f, 'city'));
  f_zip := public._jsonb_text_array(f, 'zip');
  f_status := public._lower_text_array(public._jsonb_text_array(f, 'status'));
  x_county := public._lower_text_array(public._jsonb_text_array(f, 'exclude_county'));
  x_party := public._lower_text_array(public._jsonb_text_array(f, 'exclude_party'));
  x_city := public._lower_text_array(public._jsonb_text_array(f, 'exclude_city'));
  x_zip := public._jsonb_text_array(f, 'exclude_zip');
  x_status := public._lower_text_array(public._jsonb_text_array(f, 'exclude_status'));

  f_age_min := nullif(f->>'age_min', '')::int;
  f_age_max := nullif(f->>'age_max', '')::int;
  f_support_min := nullif(f->>'support_score_min', '')::int;
  f_support_max := nullif(f->>'support_score_max', '')::int;
  x_age_min := nullif(f->>'exclude_age_min', '')::int;
  x_age_max := nullif(f->>'exclude_age_max', '')::int;
  x_support_min := nullif(f->>'exclude_support_score_min', '')::int;
  x_support_max := nullif(f->>'exclude_support_score_max', '')::int;
  f_has_coords := nullif(f->>'has_coords', '')::boolean;
  f_signed := public._jsonb_text_array(f, 'signed');
  x_signed := public._jsonb_text_array(f, 'exclude_signed');
  f_signed_any := nullif(f->>'signed_any', '')::boolean;
  f_signed_all_core := nullif(f->>'signed_all_core', '')::boolean;

  f_alignment := public._lower_text_array(public._jsonb_text_array(f, 'alignment_label'));
  f_yard := public._lower_text_array(public._jsonb_text_array(f, 'yard_sign'));
  f_volunteer := public._lower_text_array(public._jsonb_text_array(f, 'volunteer_interest'));
  f_newsletter := public._lower_text_array(public._jsonb_text_array(f, 'newsletter'));
  f_donated := public._lower_text_array(public._jsonb_text_array(f, 'donated'));
  f_attended := public._lower_text_array(public._jsonb_text_array(f, 'attended_event'));
  f_topic := public._lower_text_array(public._jsonb_text_array(f, 'top_main_topic'));
  f_convos_support := public._lower_text_array(public._jsonb_text_array(f, 'convos_candidate_support'));
  f_convos_status := public._lower_text_array(public._jsonb_text_array(f, 'convos_contact_status'));
  x_alignment := public._lower_text_array(public._jsonb_text_array(f, 'exclude_alignment_label'));
  x_yard := public._lower_text_array(public._jsonb_text_array(f, 'exclude_yard_sign'));
  x_volunteer := public._lower_text_array(public._jsonb_text_array(f, 'exclude_volunteer_interest'));
  x_newsletter := public._lower_text_array(public._jsonb_text_array(f, 'exclude_newsletter'));
  x_donated := public._lower_text_array(public._jsonb_text_array(f, 'exclude_donated'));
  x_attended := public._lower_text_array(public._jsonb_text_array(f, 'exclude_attended_event'));
  x_topic := public._lower_text_array(public._jsonb_text_array(f, 'exclude_top_main_topic'));
  x_convos_support := public._lower_text_array(public._jsonb_text_array(f, 'exclude_convos_candidate_support'));
  x_convos_status := public._lower_text_array(public._jsonb_text_array(f, 'exclude_convos_contact_status'));

  f_has_volunteer := nullif(f->>'has_volunteer', '')::boolean;
  f_has_yard := nullif(f->>'has_yard_sign', '')::boolean;
  f_has_donated := nullif(f->>'has_donated', '')::boolean;
  x_has_volunteer := nullif(f->>'exclude_has_volunteer', '')::boolean;
  x_has_yard := nullif(f->>'exclude_has_yard_sign', '')::boolean;
  x_has_donated := nullif(f->>'exclude_has_donated', '')::boolean;
  x_campaign_volunteer := nullif(f->>'exclude_campaign_volunteer', '')::boolean;
  f_nearby_yard := nullif(f->>'nearby_yard_sign_miles', '')::double precision;
  f_nearby_vol := nullif(f->>'nearby_volunteer_miles', '')::double precision;

  need_open := f_signed is not null and 'open_primaries' = any (f_signed);
  need_repro := f_signed is not null and 'reproductive_freedom' = any (f_signed);
  need_achilles := f_signed is not null and 'achilles' = any (f_signed);
  need_mmj := f_signed is not null and 'medical_marijuana_valid' = any (f_signed);
  x_open := x_signed is not null and 'open_primaries' = any (x_signed);
  x_repro := x_signed is not null and 'reproductive_freedom' = any (x_signed);
  x_achilles := x_signed is not null and 'achilles' = any (x_signed);
  x_mmj := x_signed is not null and 'medical_marijuana_valid' = any (x_signed);

  age_val := coalesce(
    v.age,
    case when v.birth_year is not null
      then extract(year from current_date)::int - v.birth_year
    end
  );

  return
    public._voter_matches_any_of(v, f->'any_of')
    and public._arr_match(v.county, f_county, false)
    and public._arr_match(v.party, f_party, false)
    and public._arr_match(v.city, f_city, false)
    and (f_zip is null or v.zip = any (f_zip))
    and public._arr_match(v.status, f_status, false)
    and public._arr_match(v.county, x_county, true)
    and public._arr_match(v.party, x_party, true)
    and public._arr_match(v.city, x_city, true)
    and (x_zip is null or not (v.zip = any (x_zip)))
    and public._arr_match(v.status, x_status, true)
    and (f_age_min is null or age_val >= f_age_min)
    and (f_age_max is null or age_val <= f_age_max)
    and (f_support_min is null or (v.support_score is not null and v.support_score >= f_support_min))
    and (f_support_max is null or (v.support_score is not null and v.support_score <= f_support_max))
    and (
      (x_age_min is null and x_age_max is null)
      or age_val is null
      or not (
        (x_age_min is null or age_val >= x_age_min)
        and (x_age_max is null or age_val <= x_age_max)
      )
    )
    and (
      (x_support_min is null and x_support_max is null)
      or v.support_score is null
      or not (
        (x_support_min is null or v.support_score >= x_support_min)
        and (x_support_max is null or v.support_score <= x_support_max)
      )
    )
    and (f_has_coords is null or not f_has_coords or (v.lat is not null and v.lng is not null))
    and (not need_open or public._is_signed(v.sig_open_primaries))
    and (not need_repro or public._has_reproductive_freedom(v))
    and (not need_achilles or public._is_signed(v.sig_achilles_petition))
    and (not need_mmj or public._is_signed(v.sig_medical_marijuana_valid_code))
    and (not x_open or not public._is_signed(v.sig_open_primaries))
    and (not x_repro or not public._has_reproductive_freedom(v))
    and (not x_achilles or not public._is_signed(v.sig_achilles_petition))
    and (not x_mmj or not public._is_signed(v.sig_medical_marijuana_valid_code))
    and (f_signed_any is null or not f_signed_any or public._is_signed(v.sig_open_primaries) or public._has_reproductive_freedom(v) or public._is_signed(v.sig_achilles_petition) or public._is_signed(v.sig_medical_marijuana_valid_code))
    and (f_signed_all_core is null or not f_signed_all_core or (public._is_signed(v.sig_open_primaries) and public._has_reproductive_freedom(v) and public._is_signed(v.sig_achilles_petition)))
    and public._arr_match(v.alignment_label, f_alignment, false)
    and public._arr_match(v.yard_sign, f_yard, false)
    and public._arr_match(v.volunteer_interest, f_volunteer, false)
    and public._arr_match(v.newsletter, f_newsletter, false)
    and public._arr_match(v.donated, f_donated, false)
    and public._arr_match(v.attended_event, f_attended, false)
    and public._arr_match(v.top_main_topic, f_topic, false)
    and public._arr_match(v.convos_candidate_support, f_convos_support, false)
    and public._arr_match(v.convos_contact_status, f_convos_status, false)
    and public._arr_match(v.alignment_label, x_alignment, true)
    and public._arr_match(v.yard_sign, x_yard, true)
    and public._arr_match(v.volunteer_interest, x_volunteer, true)
    and public._arr_match(v.newsletter, x_newsletter, true)
    and public._arr_match(v.donated, x_donated, true)
    and public._arr_match(v.attended_event, x_attended, true)
    and public._arr_match(v.top_main_topic, x_topic, true)
    and public._arr_match(v.convos_candidate_support, x_convos_support, true)
    and public._arr_match(v.convos_contact_status, x_convos_status, true)
    and (f_has_volunteer is null or not f_has_volunteer or public._is_truthy_yes(v.volunteer_interest))
    and (f_has_yard is null or not f_has_yard or public._is_truthy_yes(v.yard_sign))
    and (f_has_donated is null or not f_has_donated or public._is_truthy_yes(v.donated))
    and (x_has_volunteer is null or not x_has_volunteer or not public._is_truthy_yes(v.volunteer_interest))
    and (x_has_yard is null or not x_has_yard or not public._is_truthy_yes(v.yard_sign))
    and (x_has_donated is null or not x_has_donated or not public._is_truthy_yes(v.donated))
    and (x_campaign_volunteer is null or not x_campaign_volunteer or not v.is_campaign_volunteer)
    and (
      f_nearby_yard is null
      or public._has_nearby_geo(v.lat, v.lng, 'yard_sign', f_nearby_yard)
    )
    and (
      f_nearby_vol is null
      or public._has_nearby_geo(v.lat, v.lng, 'volunteer', f_nearby_vol)
    );
end;
$$;

grant execute on function public._voter_matches_any_of(public.voters, jsonb) to service_role;
