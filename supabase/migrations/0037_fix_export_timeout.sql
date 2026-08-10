-- Fix voter_export_page statement timeouts.
--
-- Same root cause as search/analytics before 0017/0018: the old export RPC
-- called voters_match_filters() per row (reparses filters jsonb every time).
-- Petition combo / donated / nearby exports hit the ~8s gateway timeout.
--
-- Rewrite like voter_search: extract filters once, inline WHERE, cursor by id.
-- Nearby distances are left for the API enricher (not computed in SQL).

CREATE OR REPLACE FUNCTION public.voter_export_page(
  filters jsonb DEFAULT '{}'::jsonb,
  after_id bigint DEFAULT NULL,
  lim int DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
declare
  f jsonb := coalesce(filters, '{}'::jsonb);
  safe_limit int := least(greatest(coalesce(lim, 1000), 1), 5000);
  f_county text[]; f_party text[]; f_city text[]; f_zip text[]; f_status text[]; f_state text[];
  x_county text[]; x_party text[]; x_city text[]; x_zip text[]; x_status text[]; x_state text[];
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
  f_nearby_yard_min double precision; f_nearby_vol_min double precision;
  f_supporter_tag text[];
  x_supporter_tag text[];
  f_any_of jsonb;
  need_open boolean; need_repro boolean; need_achilles boolean; need_mmj boolean;
  x_open boolean; x_repro boolean; x_achilles boolean; x_mmj boolean;
  has_filters boolean;
  rows_json jsonb;
  next_cursor bigint;
begin
  perform set_config('statement_timeout', '60s', true);

  f_county := public._lower_text_array(public._jsonb_text_array(f, 'county'));
  f_party := public._lower_text_array(public._jsonb_text_array(f, 'party'));
  f_city := public._lower_text_array(public._jsonb_text_array(f, 'city'));
  f_zip := public._jsonb_text_array(f, 'zip');
  f_status := public._lower_text_array(public._jsonb_text_array(f, 'status'));
  f_state := public._lower_text_array(public._jsonb_text_array(f, 'state'));
  x_county := public._lower_text_array(public._jsonb_text_array(f, 'exclude_county'));
  x_party := public._lower_text_array(public._jsonb_text_array(f, 'exclude_party'));
  x_city := public._lower_text_array(public._jsonb_text_array(f, 'exclude_city'));
  x_zip := public._jsonb_text_array(f, 'exclude_zip');
  x_status := public._lower_text_array(public._jsonb_text_array(f, 'exclude_status'));
  x_state := public._lower_text_array(public._jsonb_text_array(f, 'exclude_state'));
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
  f_nearby_yard := coalesce(
    nullif(f->>'nearby_yard_sign_max_miles', '')::double precision,
    nullif(f->>'nearby_yard_sign_miles', '')::double precision
  );
  f_nearby_vol := coalesce(
    nullif(f->>'nearby_volunteer_max_miles', '')::double precision,
    nullif(f->>'nearby_volunteer_miles', '')::double precision
  );
  f_nearby_yard_min := nullif(f->>'nearby_yard_sign_min_miles', '')::double precision;
  f_nearby_vol_min := nullif(f->>'nearby_volunteer_min_miles', '')::double precision;
  f_supporter_tag := public._lower_text_array(public._jsonb_text_array(f, 'supporter_tag'));
  x_supporter_tag := public._lower_text_array(public._jsonb_text_array(f, 'exclude_supporter_tag'));
  f_any_of := f->'any_of';
  need_open := f_signed is not null and 'open_primaries' = any (f_signed);
  need_repro := f_signed is not null and 'reproductive_freedom' = any (f_signed);
  need_achilles := f_signed is not null and 'achilles' = any (f_signed);
  need_mmj := f_signed is not null and 'medical_marijuana_valid' = any (f_signed);
  x_open := x_signed is not null and 'open_primaries' = any (x_signed);
  x_repro := x_signed is not null and 'reproductive_freedom' = any (x_signed);
  x_achilles := x_signed is not null and 'achilles' = any (x_signed);
  x_mmj := x_signed is not null and 'medical_marijuana_valid' = any (x_signed);

  has_filters :=
    f_county is not null or f_party is not null or f_city is not null or f_zip is not null
    or f_status is not null or f_state is not null
    or x_county is not null or x_party is not null or x_city is not null or x_zip is not null
    or x_status is not null or x_state is not null
    or f_age_min is not null or f_age_max is not null or f_support_min is not null or f_support_max is not null
    or x_age_min is not null or x_age_max is not null or x_support_min is not null or x_support_max is not null
    or f_has_coords is not null or f_signed is not null or x_signed is not null
    or f_signed_any is not null or f_signed_all_core is not null
    or f_alignment is not null or f_yard is not null or f_volunteer is not null or f_newsletter is not null
    or f_donated is not null or f_attended is not null or f_topic is not null
    or f_convos_support is not null or f_convos_status is not null
    or x_alignment is not null or x_yard is not null or x_volunteer is not null or x_newsletter is not null
    or x_donated is not null or x_attended is not null or x_topic is not null
    or x_convos_support is not null or x_convos_status is not null
    or f_has_volunteer is not null or f_has_yard is not null or f_has_donated is not null
    or x_has_volunteer is not null or x_has_yard is not null or x_has_donated is not null
    or x_campaign_volunteer is not null
    or f_nearby_yard is not null or f_nearby_vol is not null
    or f_nearby_yard_min is not null or f_nearby_vol_min is not null
    or f_supporter_tag is not null or x_supporter_tag is not null
    or (
      f_any_of is not null
      and jsonb_typeof(f_any_of) = 'array'
      and jsonb_array_length(f_any_of) > 0
    );

  -- Fast path: no filters — index scan by id.
  if not has_filters then
    with filtered as (
      select
        v.id, v.murmuration_id, v.voter_id, v.first_name, v.last_name, v.email, v.phone, v.age,
        v.address_line_1, v.city, v.county, v.zip, v.state, v.lat, v.lng,
        v.party, v.voter_registered, v.status,
        v.sig_open_primaries, v.sig_reproductive_freedom, v.sig_achilles_petition,
        v.sig_medical_cannabis, v.sig_medical_marijuana_valid_code,
        v.sig_reproductive_freedom_valid_code,
        v.volunteer_interest, v.yard_sign, v.support_score, v.newsletter,
        v.legacy_volunteer, v.alignment_score, v.top_main_topic, v.alignment_label,
        v.contact_tags, v.convos_candidate_support, v.convos_contact_status,
        v.convos_poll_question, v.donated, v.attended_event, v.supporter_tag,
        v.is_campaign_volunteer
      from public.voters v
      where after_id is null or v.id > after_id
      order by v.id
      limit safe_limit
    )
    select
      coalesce(jsonb_agg(to_jsonb(filtered) order by id), '[]'::jsonb),
      max(id)
    into rows_json, next_cursor
    from filtered;

    return jsonb_build_object(
      'rows', rows_json,
      'next_cursor', case
        when jsonb_array_length(rows_json) < safe_limit then null
        else next_cursor
      end
    );
  end if;

  with filtered as (
    select
      v.id, v.murmuration_id, v.voter_id, v.first_name, v.last_name, v.email, v.phone, v.age,
      v.address_line_1, v.city, v.county, v.zip, v.state, v.lat, v.lng,
      v.party, v.voter_registered, v.status,
      v.sig_open_primaries, v.sig_reproductive_freedom, v.sig_achilles_petition,
      v.sig_medical_cannabis, v.sig_medical_marijuana_valid_code,
      v.sig_reproductive_freedom_valid_code,
      v.volunteer_interest, v.yard_sign, v.support_score, v.newsletter,
      v.legacy_volunteer, v.alignment_score, v.top_main_topic, v.alignment_label,
      v.contact_tags, v.convos_candidate_support, v.convos_contact_status,
      v.convos_poll_question, v.donated, v.attended_event, v.supporter_tag,
      v.is_campaign_volunteer
    from public.voters v
    where
      (after_id is null or v.id > after_id)
      and (
        f_any_of is null
        or jsonb_typeof(f_any_of) <> 'array'
        or jsonb_array_length(f_any_of) = 0
        or public._voter_matches_any_of(v, f_any_of)
      )
      and public._arr_match(v.county, f_county, false)
      and public._arr_match(v.party, f_party, false)
      and public._arr_match(v.city, f_city, false)
      and (f_zip is null or v.zip = any (f_zip))
      and public._arr_match(v.status, f_status, false)
      and public._state_matches(v.state, f_state, false)
      and public._arr_match(v.county, x_county, true)
      and public._arr_match(v.party, x_party, true)
      and public._arr_match(v.city, x_city, true)
      and (x_zip is null or not (v.zip = any (x_zip)))
      and public._arr_match(v.status, x_status, true)
      and public._state_matches(v.state, x_state, true)
      and (
        f_age_min is null
        or coalesce(
          v.age,
          case when v.birth_year is not null
            then extract(year from current_date)::int - v.birth_year
          end
        ) >= f_age_min
      )
      and (
        f_age_max is null
        or coalesce(
          v.age,
          case when v.birth_year is not null
            then extract(year from current_date)::int - v.birth_year
          end
        ) <= f_age_max
      )
      and (f_support_min is null or (v.support_score is not null and v.support_score >= f_support_min))
      and (f_support_max is null or (v.support_score is not null and v.support_score <= f_support_max))
      and (
        (x_age_min is null and x_age_max is null)
        or coalesce(
          v.age,
          case when v.birth_year is not null
            then extract(year from current_date)::int - v.birth_year
          end
        ) is null
        or not (
          (
            x_age_min is null
            or coalesce(
              v.age,
              case when v.birth_year is not null
                then extract(year from current_date)::int - v.birth_year
              end
            ) >= x_age_min
          )
          and (
            x_age_max is null
            or coalesce(
              v.age,
              case when v.birth_year is not null
                then extract(year from current_date)::int - v.birth_year
              end
            ) <= x_age_max
          )
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
      and (
        f_signed_any is null
        or not f_signed_any
        or public._is_signed(v.sig_open_primaries)
        or public._has_reproductive_freedom(v)
        or public._is_signed(v.sig_achilles_petition)
        or public._is_signed(v.sig_medical_marijuana_valid_code)
      )
      and (
        f_signed_all_core is null
        or not f_signed_all_core
        or (
          public._is_signed(v.sig_open_primaries)
          and public._has_reproductive_freedom(v)
          and public._is_signed(v.sig_achilles_petition)
        )
      )
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
        (f_nearby_yard is null and f_nearby_yard_min is null)
        or public._has_nearby_geo_range(v.lat, v.lng, 'yard_sign', f_nearby_yard_min, f_nearby_yard)
      )
      and (
        (f_nearby_vol is null and f_nearby_vol_min is null)
        or public._has_nearby_geo_range(v.lat, v.lng, 'volunteer', f_nearby_vol_min, f_nearby_vol)
      )
      and (
        f_supporter_tag is null
        or lower(coalesce(v.supporter_tag, '')) = any (f_supporter_tag)
      )
      and (
        x_supporter_tag is null
        or not (lower(coalesce(v.supporter_tag, '')) = any (x_supporter_tag))
      )
    order by v.id
    limit safe_limit
  )
  select
    coalesce(jsonb_agg(to_jsonb(filtered) order by id), '[]'::jsonb),
    max(id)
  into rows_json, next_cursor
  from filtered;

  return jsonb_build_object(
    'rows', rows_json,
    'next_cursor', case
      when jsonb_array_length(rows_json) < safe_limit then null
      else next_cursor
    end
  );
end;
$$;

revoke all on function public.voter_export_page(jsonb, bigint, int) from public;
grant execute on function public.voter_export_page(jsonb, bigint, int) to service_role;
