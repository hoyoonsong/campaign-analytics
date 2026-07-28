-- Exclude supporter tags as a whole (supporter / maybe / opposed).
-- Also teaches analytics + match_filters to honor include supporter_tag.

CREATE OR REPLACE FUNCTION public.voters_match_filters(v voters, filters jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  f jsonb := coalesce(filters, '{}'::jsonb);
  f_county text[]; f_party text[]; f_city text[]; f_zip text[]; f_status text[];
  f_state text[];
  x_county text[]; x_party text[]; x_city text[]; x_zip text[]; x_status text[];
  x_state text[];
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
  f_supporter_tag text[];
  x_supporter_tag text[];
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
  f_supporter_tag := public._lower_text_array(public._jsonb_text_array(f, 'supporter_tag'));
  x_supporter_tag := public._lower_text_array(public._jsonb_text_array(f, 'exclude_supporter_tag'));
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
      and public._state_matches(v.state, f_state, false)
    and public._arr_match(v.county, x_county, true)
    and public._arr_match(v.party, x_party, true)
    and public._arr_match(v.city, x_city, true)
    and (x_zip is null or not (v.zip = any (x_zip)))
    and public._arr_match(v.status, x_status, true)
      and public._state_matches(v.state, x_state, true)
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
    and (f_supporter_tag is null or lower(coalesce(v.supporter_tag, '')) = any (f_supporter_tag))
    and (x_supporter_tag is null or not (lower(coalesce(v.supporter_tag, '')) = any (x_supporter_tag)))
    and (
      f_nearby_yard is null
      or public._has_nearby_geo(v.lat, v.lng, 'yard_sign', f_nearby_yard)
    )
    and (
      f_nearby_vol is null
      or public._has_nearby_geo(v.lat, v.lng, 'volunteer', f_nearby_vol)
    );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.voter_search(filters jsonb DEFAULT '{}'::jsonb, q text DEFAULT ''::text, page integer DEFAULT 1, page_size integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  f jsonb := coalesce(filters, '{}'::jsonb);
  safe_page int := greatest(coalesce(page, 1), 1);
  safe_size int := least(greatest(coalesce(page_size, 50), 1), 100);
  offset_rows int;
  needle text := nullif(trim(coalesce(q, '')), '');
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
  display_miles double precision := 500.0;
  total_count bigint;
  rows_json jsonb;
begin
  perform set_config('statement_timeout', '60s', true);
  offset_rows := (safe_page - 1) * safe_size;

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

  if f_nearby_yard is not null then
    display_miles := greatest(display_miles, f_nearby_yard);
  elsif f_nearby_yard_min is not null then
    display_miles := greatest(display_miles, greatest(f_nearby_yard_min * 2, 5));
  end if;
  if f_nearby_vol is not null then
    display_miles := greatest(display_miles, f_nearby_vol);
  elsif f_nearby_vol_min is not null then
    display_miles := greatest(display_miles, greatest(f_nearby_vol_min * 2, 5));
  end if;

  has_filters :=
    f_county is not null or f_party is not null or f_city is not null or f_zip is not null or f_status is not null or f_state is not null
    or x_county is not null or x_party is not null or x_city is not null or x_zip is not null or x_status is not null or x_state is not null
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
    or f_state is not null or x_state is not null
    or f_supporter_tag is not null
    or x_supporter_tag is not null
    or (
      f_any_of is not null
      and jsonb_typeof(f_any_of) = 'array'
      and jsonb_array_length(f_any_of) > 0
    );

  -- Fast path: no text query, no filters — avoid per-row matcher + window count.
  if needle is null and not has_filters then
    select coalesce(
      (select universe_total from public.campaign_sync_state where id = 1),
      (select count(*) from public.voters)
    ) into total_count;
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'murmuration_id', t.murmuration_id,
          'voter_id', t.voter_id,
          'first_name', t.first_name,
          'last_name', t.last_name,
          'email', t.email,
          'phone', t.phone,
          'address_line_1', t.address_line_1,
          'city', t.city,
          'state', t.state,
          'zip', t.zip,
          'county', t.county,
          'party', t.party,
          'age', t.age,
          'status', t.status,
          'support_score', t.support_score,
          'lat', t.lat,
          'lng', t.lng,
          'supporter_tag', t.supporter_tag,
          'is_campaign_volunteer', t.is_campaign_volunteer,
          'campaign_person_id', t.campaign_person_id,
          'nearby_yard_sign_miles', public._nearest_geo_miles(t.lat, t.lng, 'yard_sign', display_miles),
          'nearby_volunteer_miles', public._nearest_geo_miles(t.lat, t.lng, 'volunteer', display_miles)
        )
        order by t.last_name nulls last, t.first_name nulls last, t.id
      ),
      '[]'::jsonb
    )
    into rows_json
    from (
      select
        id, murmuration_id, voter_id, first_name, last_name, email, phone,
        address_line_1, city, state, zip, county, party, age, status, support_score,
        lat, lng, supporter_tag, is_campaign_volunteer, campaign_person_id
      from public.voters
      order by last_name nulls last, first_name nulls last, id
      offset offset_rows limit safe_size
    ) t;
    return jsonb_build_object(
      'rows', coalesce(rows_json, '[]'::jsonb),
      'total', total_count,
      'page', safe_page,
      'page_size', safe_size
    );
  end if;

  with matched as (
    select
      v.id, v.murmuration_id, v.voter_id, v.first_name, v.last_name, v.email, v.phone,
      v.address_line_1, v.city, v.state, v.zip, v.county, v.party, v.age, v.status,
      v.support_score, v.lat, v.lng,
      v.supporter_tag, v.is_campaign_volunteer, v.campaign_person_id,
      count(*) over() as full_count
    from public.voters v
    where
      (
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
      and (
        needle is null
        or v.murmuration_id ilike '%'||needle||'%'
        or v.voter_id ilike '%'||needle||'%'
        or v.first_name ilike '%'||needle||'%'
        or v.last_name ilike '%'||needle||'%'
        or (coalesce(v.first_name,'')||' '||coalesce(v.last_name,'')) ilike '%'||needle||'%'
        or v.address_line_1 ilike '%'||needle||'%'
        or v.city ilike '%'||needle||'%'
        or v.zip ilike '%'||needle||'%'
        or v.email ilike '%'||needle||'%'
        or v.phone ilike '%'||needle||'%'
      )
    order by v.last_name nulls last, v.first_name nulls last, v.id
    offset offset_rows limit safe_size
  )
  select
    coalesce(max(full_count), 0),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', id,
          'murmuration_id', murmuration_id,
          'voter_id', voter_id,
          'first_name', first_name,
          'last_name', last_name,
          'email', email,
          'phone', phone,
          'address_line_1', address_line_1,
          'city', city,
          'state', state,
          'zip', zip,
          'county', county,
          'party', party,
          'age', age,
          'status', status,
          'support_score', support_score,
          'lat', lat,
          'lng', lng,
          'supporter_tag', supporter_tag,
          'is_campaign_volunteer', is_campaign_volunteer,
          'campaign_person_id', campaign_person_id,
          'nearby_yard_sign_miles', public._nearest_geo_miles(lat, lng, 'yard_sign', display_miles),
          'nearby_volunteer_miles', public._nearest_geo_miles(lat, lng, 'volunteer', display_miles)
        )
        order by last_name nulls last, first_name nulls last, id
      ),
      '[]'::jsonb
    )
  into total_count, rows_json
  from matched;

  return jsonb_build_object(
    'rows', coalesce(rows_json, '[]'::jsonb),
    'total', coalesce(total_count, 0),
    'page', safe_page,
    'page_size', safe_size
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.voter_analytics_summary(filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  f jsonb := coalesce(filters, '{}'::jsonb);
  f_county text[]; f_party text[]; f_city text[]; f_zip text[]; f_status text[];
  f_state text[];
  x_county text[]; x_party text[]; x_city text[]; x_zip text[]; x_status text[];
  x_state text[];
  f_age_min int; f_age_max int; f_support_min int; f_support_max int;
  x_age_min int; x_age_max int; x_support_min int; x_support_max int;
  f_has_coords boolean; f_signed text[]; f_signed_any boolean; f_signed_all_core boolean;
  x_signed text[];
  f_alignment text[]; f_yard text[]; f_volunteer text[]; f_newsletter text[];
  f_donated text[]; f_attended text[]; f_topic text[]; f_convos_support text[]; f_convos_status text[];
  x_alignment text[]; x_yard text[]; x_volunteer text[]; x_newsletter text[];
  x_donated text[]; x_attended text[]; x_topic text[]; x_convos_support text[]; x_convos_status text[];
  f_has_volunteer boolean; f_has_yard boolean; f_has_donated boolean;
  x_has_volunteer boolean; x_has_yard boolean; x_has_donated boolean;
  x_campaign_volunteer boolean;
  f_supporter_tag text[];
  x_supporter_tag text[];
  f_nearby_yard double precision; f_nearby_vol double precision;
  f_any_of jsonb;
  need_open boolean; need_repro boolean; need_achilles boolean; need_mmj boolean;
  x_open boolean; x_repro boolean; x_achilles boolean; x_mmj boolean;
  result jsonb;
begin
  perform set_config('statement_timeout', '120s', true);

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
  f_supporter_tag := public._lower_text_array(public._jsonb_text_array(f, 'supporter_tag'));
  x_supporter_tag := public._lower_text_array(public._jsonb_text_array(f, 'exclude_supporter_tag'));
  f_nearby_yard := nullif(f->>'nearby_yard_sign_miles', '')::double precision;
  f_nearby_vol := nullif(f->>'nearby_volunteer_miles', '')::double precision;
  f_any_of := f->'any_of';

  need_open := f_signed is not null and 'open_primaries' = any (f_signed);
  need_repro := f_signed is not null and 'reproductive_freedom' = any (f_signed);
  need_achilles := f_signed is not null and 'achilles' = any (f_signed);
  need_mmj := f_signed is not null and 'medical_marijuana_valid' = any (f_signed);
  x_open := x_signed is not null and 'open_primaries' = any (x_signed);
  x_repro := x_signed is not null and 'reproductive_freedom' = any (x_signed);
  x_achilles := x_signed is not null and 'achilles' = any (x_signed);
  x_mmj := x_signed is not null and 'medical_marijuana_valid' = any (x_signed);

  with filtered as (
    select
      v.county, v.party, v.status, v.age, v.birth_year, v.lat, v.lng, v.supporter_tag,
      public._is_signed(v.sig_open_primaries) as s_open,
      public._has_reproductive_freedom(v) as s_repro,
      public._is_signed(v.sig_achilles_petition) as s_achilles,
      public._is_signed(v.sig_medical_marijuana_valid_code) as s_mmj_code
    from public.voters v
    where
      (
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
        f_supporter_tag is null
        or lower(coalesce(v.supporter_tag, '')) = any (f_supporter_tag)
      )
      and (
        x_supporter_tag is null
        or not (lower(coalesce(v.supporter_tag, '')) = any (x_supporter_tag))
      )
      and (
        f_nearby_yard is null
        or public._has_nearby_geo(v.lat, v.lng, 'yard_sign', f_nearby_yard)
      )
      and (
        f_nearby_vol is null
        or public._has_nearby_geo(v.lat, v.lng, 'volunteer', f_nearby_vol)
      )
  ),
  agg as (
    select
      count(*)::bigint as total,
      count(*) filter (where lat is not null and lng is not null)::bigint as with_coords,
      count(*) filter (where s_open)::bigint as open_primaries,
      count(*) filter (where s_repro)::bigint as reproductive_freedom,
      count(*) filter (where s_achilles)::bigint as achilles_petition,
      count(*) filter (where s_mmj_code)::bigint as medical_marijuana_valid,
      count(*) filter (where s_open and s_repro and s_achilles)::bigint as signed_all_core,
      count(*) filter (where s_open and s_repro and s_achilles and s_mmj_code)::bigint as signed_all_four,
      count(*) filter (where s_open or s_repro or s_achilles or s_mmj_code)::bigint as signed_any
    from filtered
  ),
  by_county as (
    select coalesce(nullif(county, ''), '(blank)') as key, count(*)::bigint as count
    from filtered group by 1 order by count desc, key limit 100
  ),
  by_party as (
    select coalesce(nullif(party, ''), '(blank)') as key, count(*)::bigint as count
    from filtered group by 1 order by count desc, key limit 50
  ),
  by_status as (
    select coalesce(nullif(status, ''), '(blank)') as key, count(*)::bigint as count
    from filtered group by 1 order by count desc, key limit 50
  ),
  by_supporter_tag as (
    select coalesce(nullif(lower(supporter_tag), ''), '(untagged)') as key, count(*)::bigint as count
    from filtered group by 1 order by count desc, key
  ),
  by_age as (
    select
      case
        when coalesce(age, case when birth_year is not null then extract(year from current_date)::int - birth_year end) is null then 'Unknown'
        when coalesce(age, extract(year from current_date)::int - birth_year) < 18 then 'Under 18'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 18 and 24 then '18–24'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 25 and 34 then '25–34'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 35 and 44 then '35–44'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 45 and 54 then '45–54'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 55 and 64 then '55–64'
        else '65+'
      end as key,
      count(*)::bigint as count
    from filtered group by 1
  ),
  by_petition_count as (
    select ((s_open::int) + (s_repro::int) + (s_achilles::int) + (s_mmj_code::int))::text as key,
      count(*)::bigint as count
    from filtered group by 1 order by 1
  )
  select jsonb_build_object(
    'total', a.total,
    'with_coords', a.with_coords,
    'by_county', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_county), '[]'::jsonb),
    'by_party', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_party), '[]'::jsonb),
    'by_status', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_status), '[]'::jsonb),
    'by_supporter_tag', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_supporter_tag), '[]'::jsonb),
    'supporters', coalesce((select count from by_supporter_tag where key = 'supporter'), 0),
    'maybes', coalesce((select count from by_supporter_tag where key = 'maybe'), 0),
    'opposed', coalesce((select count from by_supporter_tag where key = 'opposed'), 0),
    'by_age', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_age), '[]'::jsonb),
    'signatures', jsonb_build_object(
      'open_primaries', a.open_primaries,
      'reproductive_freedom', a.reproductive_freedom,
      'achilles_petition', a.achilles_petition,
      'medical_cannabis', 0,
      'medical_marijuana_valid', a.medical_marijuana_valid,
      'reproductive_freedom_valid', a.reproductive_freedom,
      'signed_all_core', a.signed_all_core,
      'signed_all_four', a.signed_all_four,
      'signed_any', a.signed_any
    ),
    'by_signature', jsonb_build_array(
      jsonb_build_object('key', 'Open Primaries', 'count', a.open_primaries),
      jsonb_build_object('key', 'Reproductive Freedom', 'count', a.reproductive_freedom),
      jsonb_build_object('key', 'Achilles Petition', 'count', a.achilles_petition),
      jsonb_build_object('key', 'Medical Marijuana (VAL)', 'count', a.medical_marijuana_valid)
    ),
    'by_petition_count', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_petition_count), '[]'::jsonb)
  ) into result from agg a;

  return result;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.voter_map_points(filters jsonb DEFAULT '{}'::jsonb, lim integer DEFAULT 2500)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  f jsonb := coalesce(filters, '{}'::jsonb);
  safe_limit int := least(greatest(coalesce(lim, 2500), 1), 8000);
  total_with_coords bigint;
  rows_json jsonb;
  f_county text[]; f_party text[]; f_city text[]; f_zip text[]; f_status text[]; f_state text[];
  x_state text[];
  f_supporter_tag text[];
  x_supporter_tag text[];
  f_nearby_yard double precision; f_nearby_vol double precision;
  f_nearby_yard_min double precision; f_nearby_vol_min double precision;
  has_filters boolean;
begin
  perform set_config('statement_timeout', '60s', true);

  f_county := public._lower_text_array(public._jsonb_text_array(f, 'county'));
  f_party := public._lower_text_array(public._jsonb_text_array(f, 'party'));
  f_city := public._lower_text_array(public._jsonb_text_array(f, 'city'));
  f_zip := public._jsonb_text_array(f, 'zip');
  f_status := public._lower_text_array(public._jsonb_text_array(f, 'status'));
  f_state := public._lower_text_array(public._jsonb_text_array(f, 'state'));
  x_state := public._lower_text_array(public._jsonb_text_array(f, 'exclude_state'));
  f_supporter_tag := public._lower_text_array(public._jsonb_text_array(f, 'supporter_tag'));
  x_supporter_tag := public._lower_text_array(public._jsonb_text_array(f, 'exclude_supporter_tag'));
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

  has_filters :=
    f_county is not null or f_party is not null or f_city is not null or f_zip is not null
    or f_status is not null or f_state is not null or x_state is not null or f_supporter_tag is not null or x_supporter_tag is not null
    or f_nearby_yard is not null or f_nearby_vol is not null
    or f_nearby_yard_min is not null or f_nearby_vol_min is not null
    or (f ? 'any_of' and jsonb_typeof(f->'any_of') = 'array' and jsonb_array_length(f->'any_of') > 0)
    or (f ? 'signed' and jsonb_typeof(f->'signed') = 'array' and jsonb_array_length(f->'signed') > 0);

  if not has_filters then
    select count(*) into total_with_coords
    from public.voters v
    where v.lat is not null and v.lng is not null;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb)
    into rows_json
    from (
      select id, murmuration_id, voter_id, first_name, last_name,
             address_line_1, city, county, zip, party, status, age, support_score, lat, lng
      from public.voters v
      where v.lat is not null and v.lng is not null
      order by v.id
      limit safe_limit
    ) t;
  else
    select count(*) into total_with_coords
    from public.voters v
    where v.lat is not null and v.lng is not null
      and public._arr_match(v.county, f_county, false)
      and public._arr_match(v.party, f_party, false)
      and public._arr_match(v.city, f_city, false)
      and (f_zip is null or v.zip = any (f_zip))
      and public._arr_match(v.status, f_status, false)
      and public._state_matches(v.state, f_state, false)
      and public._state_matches(v.state, x_state, true)
      and (
        f_supporter_tag is null
        or lower(coalesce(v.supporter_tag, '')) = any (f_supporter_tag)
      )
      and (
        x_supporter_tag is null
        or not (lower(coalesce(v.supporter_tag, '')) = any (x_supporter_tag))
      )
      and (
        (f_nearby_yard is null and f_nearby_yard_min is null)
        or public._has_nearby_geo_range(v.lat, v.lng, 'yard_sign', f_nearby_yard_min, f_nearby_yard)
      )
      and (
        (f_nearby_vol is null and f_nearby_vol_min is null)
        or public._has_nearby_geo_range(v.lat, v.lng, 'volunteer', f_nearby_vol_min, f_nearby_vol)
      )
      and (
        not (f ? 'any_of')
        or jsonb_typeof(f->'any_of') <> 'array'
        or jsonb_array_length(f->'any_of') = 0
        or public._voter_matches_any_of(v, f->'any_of')
      );

    select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb)
    into rows_json
    from (
      select id, murmuration_id, voter_id, first_name, last_name,
             address_line_1, city, county, zip, party, status, age, support_score, lat, lng
      from public.voters v
      where v.lat is not null and v.lng is not null
        and public._arr_match(v.county, f_county, false)
        and public._arr_match(v.party, f_party, false)
        and public._arr_match(v.city, f_city, false)
        and (f_zip is null or v.zip = any (f_zip))
        and public._arr_match(v.status, f_status, false)
        and public._state_matches(v.state, f_state, false)
      and public._state_matches(v.state, x_state, true)
        and (
        f_supporter_tag is null
        or lower(coalesce(v.supporter_tag, '')) = any (f_supporter_tag)
      )
      and (
        x_supporter_tag is null
        or not (lower(coalesce(v.supporter_tag, '')) = any (x_supporter_tag))
      )
        and (
          (f_nearby_yard is null and f_nearby_yard_min is null)
          or public._has_nearby_geo_range(v.lat, v.lng, 'yard_sign', f_nearby_yard_min, f_nearby_yard)
        )
        and (
          (f_nearby_vol is null and f_nearby_vol_min is null)
          or public._has_nearby_geo_range(v.lat, v.lng, 'volunteer', f_nearby_vol_min, f_nearby_vol)
        )
        and (
          not (f ? 'any_of')
          or jsonb_typeof(f->'any_of') <> 'array'
          or jsonb_array_length(f->'any_of') = 0
          or public._voter_matches_any_of(v, f->'any_of')
        )
      order by v.id
      limit safe_limit
    ) t;
  end if;

  return jsonb_build_object(
    'points', coalesce(rows_json, '[]'::jsonb),
    'returned', jsonb_array_length(coalesce(rows_json, '[]'::jsonb)),
    'total_with_coords', coalesce(total_with_coords, 0),
    'truncated', coalesce(total_with_coords, 0) > safe_limit
  );
end;
$function$
;

revoke all on function public.voters_match_filters(public.voters, jsonb) from public;
grant execute on function public.voters_match_filters(public.voters, jsonb) to service_role;
revoke all on function public.voter_search(jsonb, text, integer, integer) from public;
grant execute on function public.voter_search(jsonb, text, integer, integer) to service_role;
revoke all on function public.voter_analytics_summary(jsonb) from public;
grant execute on function public.voter_analytics_summary(jsonb) to service_role;
revoke all on function public.voter_map_points(jsonb, integer) from public;
grant execute on function public.voter_map_points(jsonb, integer) to service_role;
