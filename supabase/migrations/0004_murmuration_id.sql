-- Murmuration ID: stable 1:1 external key for person matching / upserts.

alter table public.voters add column if not exists murmuration_id text;

create unique index if not exists voters_murmuration_id_uidx
  on public.voters (murmuration_id)
  where murmuration_id is not null and murmuration_id <> '';

-- Prefer murmuration_id for match, then state voter_id, then PII.
create or replace function public.voter_upsert_batch(rows jsonb, batch_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  vid text;
  mid text;
  match_id bigint;
  existing public.voters;
  merged public.voters;
  inserted int := 0;
  updated int := 0;
  skipped int := 0;
  errors text[] := array[]::text[];
  email_n text;
  phone_n text;
  name_n text;
  addr_n text;
begin
  if rows is null or jsonb_typeof(rows) <> 'array' then
    return jsonb_build_object('error', 'rows must be a jsonb array');
  end if;
  if jsonb_array_length(rows) > 200 then
    return jsonb_build_object('error', 'Max 200 rows per batch');
  end if;

  for item in select * from jsonb_array_elements(rows)
  loop
    begin
      mid := nullif(trim(coalesce(item->>'murmuration_id', '')), '');
      vid := nullif(trim(coalesce(item->>'voter_id', '')), '');
      email_n := public._norm_email(item->>'email');
      phone_n := public._norm_phone(item->>'phone');
      name_n := public._norm_name(
        trim(coalesce(item->>'first_name', '') || ' ' || coalesce(item->>'last_name', ''))
      );
      addr_n := public._norm_address(item->>'address_line_1');

      match_id := null;

      if mid is not null then
        select id into match_id from public.voters where murmuration_id = mid limit 1;
      end if;

      if match_id is null and vid is not null then
        select id into match_id from public.voters where voter_id = vid limit 1;
      end if;

      if match_id is null and email_n is not null then
        select id into match_id
        from public.voters
        where public._norm_email(email) = email_n
        limit 1;
      end if;

      if match_id is null and phone_n is not null and length(phone_n) >= 7 then
        select id into match_id
        from public.voters
        where public._norm_phone(phone) = phone_n
        limit 1;
      end if;

      if match_id is null and name_n is not null and addr_n is not null then
        select id into match_id
        from public.voters
        where public._norm_name(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))) = name_n
          and public._norm_address(address_line_1) = addr_n
        limit 1;
      end if;

      -- Need at least one strong key to insert a new row.
      if match_id is null and mid is null and vid is null then
        skipped := skipped + 1;
        continue;
      end if;

      if match_id is not null then
        select * into existing from public.voters where id = match_id;
        merged := public._voter_fill_in(existing, item);

        if mid is not null then merged.murmuration_id := mid; end if;
        if vid is not null then merged.voter_id := vid; end if;

        if nullif(item->>'lat', '') is not null then
          merged.lat := (item->>'lat')::double precision;
        end if;
        if nullif(item->>'lng', '') is not null then
          merged.lng := (item->>'lng')::double precision;
        end if;
        if nullif(item->>'support_score', '') is not null then
          merged.support_score := (item->>'support_score')::smallint;
        end if;
        if nullif(item->>'age', '') is not null then
          merged.age := (item->>'age')::smallint;
        end if;
        if nullif(item->>'party', '') is not null then merged.party := item->>'party'; end if;
        if nullif(item->>'status', '') is not null then merged.status := item->>'status'; end if;
        if nullif(item->>'volunteer_interest', '') is not null then merged.volunteer_interest := item->>'volunteer_interest'; end if;
        if nullif(item->>'yard_sign', '') is not null then merged.yard_sign := item->>'yard_sign'; end if;
        if nullif(item->>'newsletter', '') is not null then merged.newsletter := item->>'newsletter'; end if;
        if nullif(item->>'donated', '') is not null then merged.donated := item->>'donated'; end if;
        if nullif(item->>'attended_event', '') is not null then merged.attended_event := item->>'attended_event'; end if;
        if nullif(item->>'contact_tags', '') is not null then merged.contact_tags := item->>'contact_tags'; end if;
        if nullif(item->>'alignment_label', '') is not null then merged.alignment_label := item->>'alignment_label'; end if;
        if nullif(item->>'convos_candidate_support', '') is not null then merged.convos_candidate_support := item->>'convos_candidate_support'; end if;
        if nullif(item->>'convos_contact_status', '') is not null then merged.convos_contact_status := item->>'convos_contact_status'; end if;

        update public.voters set
          murmuration_id = merged.murmuration_id,
          voter_id = merged.voter_id,
          first_name = merged.first_name,
          last_name = merged.last_name,
          email = merged.email,
          phone = merged.phone,
          age = merged.age,
          address_line_1 = merged.address_line_1,
          city = merged.city,
          county = merged.county,
          zip = merged.zip,
          state = merged.state,
          lat = merged.lat,
          lng = merged.lng,
          party = merged.party,
          voter_registered = merged.voter_registered,
          status = merged.status,
          sig_open_primaries = merged.sig_open_primaries,
          sig_reproductive_freedom = merged.sig_reproductive_freedom,
          sig_achilles_petition = merged.sig_achilles_petition,
          sig_medical_cannabis = merged.sig_medical_cannabis,
          sig_medical_marijuana_valid_code = merged.sig_medical_marijuana_valid_code,
          sig_reproductive_freedom_valid_code = merged.sig_reproductive_freedom_valid_code,
          volunteer_interest = merged.volunteer_interest,
          yard_sign = merged.yard_sign,
          support_score = merged.support_score,
          newsletter = merged.newsletter,
          legacy_volunteer = merged.legacy_volunteer,
          alignment_score = merged.alignment_score,
          top_main_topic = merged.top_main_topic,
          alignment_label = merged.alignment_label,
          contact_tags = merged.contact_tags,
          convos_candidate_support = merged.convos_candidate_support,
          convos_contact_status = merged.convos_contact_status,
          convos_poll_question = merged.convos_poll_question,
          donated = merged.donated,
          attended_event = merged.attended_event,
          updated_at = now()
        where id = match_id;
        updated := updated + 1;
      else
        insert into public.voters (
          murmuration_id, voter_id, first_name, last_name, email, phone, age,
          address_line_1, city, county, zip, state, lat, lng,
          party, voter_registered, status,
          sig_open_primaries, sig_reproductive_freedom, sig_achilles_petition,
          sig_medical_cannabis, sig_medical_marijuana_valid_code,
          sig_reproductive_freedom_valid_code,
          volunteer_interest, yard_sign, support_score, newsletter,
          legacy_volunteer, alignment_score, top_main_topic, alignment_label,
          contact_tags, convos_candidate_support, convos_contact_status,
          convos_poll_question, donated, attended_event
        ) values (
          mid,
          vid,
          nullif(item->>'first_name', ''),
          nullif(item->>'last_name', ''),
          nullif(item->>'email', ''),
          nullif(item->>'phone', ''),
          nullif(item->>'age', '')::smallint,
          nullif(item->>'address_line_1', ''),
          nullif(item->>'city', ''),
          nullif(item->>'county', ''),
          nullif(item->>'zip', ''),
          nullif(upper(left(item->>'state', 2)), ''),
          nullif(item->>'lat', '')::double precision,
          nullif(item->>'lng', '')::double precision,
          nullif(item->>'party', ''),
          nullif(item->>'voter_registered', ''),
          nullif(item->>'status', ''),
          nullif(item->>'sig_open_primaries', ''),
          nullif(item->>'sig_reproductive_freedom', ''),
          nullif(item->>'sig_achilles_petition', ''),
          nullif(item->>'sig_medical_cannabis', ''),
          nullif(item->>'sig_medical_marijuana_valid_code', ''),
          nullif(item->>'sig_reproductive_freedom_valid_code', ''),
          nullif(item->>'volunteer_interest', ''),
          nullif(item->>'yard_sign', ''),
          nullif(item->>'support_score', '')::smallint,
          nullif(item->>'newsletter', ''),
          nullif(item->>'legacy_volunteer', ''),
          nullif(item->>'alignment_score', ''),
          nullif(item->>'top_main_topic', ''),
          nullif(item->>'alignment_label', ''),
          nullif(item->>'contact_tags', ''),
          nullif(item->>'convos_candidate_support', ''),
          nullif(item->>'convos_contact_status', ''),
          nullif(item->>'convos_poll_question', ''),
          nullif(item->>'donated', ''),
          nullif(item->>'attended_event', '')
        );
        inserted := inserted + 1;
      end if;
    exception when others then
      errors := array_append(errors, SQLERRM);
      skipped := skipped + 1;
    end;
  end loop;

  if batch_id is not null then
    update public.voter_import_batches set
      total_rows = coalesce(total_rows, 0) + jsonb_array_length(rows),
      inserted_rows = coalesce(inserted_rows, 0) + inserted,
      updated_rows = coalesce(updated_rows, 0) + updated,
      skipped_rows = coalesce(skipped_rows, 0) + skipped,
      error_summary = case when array_length(errors, 1) > 0
        then array_to_string(errors[1:5], '; ') else error_summary end,
      status = 'running',
      updated_at = now()
    where id = batch_id;
  end if;

  return jsonb_build_object(
    'inserted', inserted,
    'updated', updated,
    'skipped', skipped,
    'errors', to_jsonb(errors)
  );
end;
$$;

-- Include murmuration_id in search / map / export payloads.
create or replace function public.voter_search(
  filters jsonb default '{}'::jsonb,
  q text default '',
  page int default 1,
  page_size int default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  safe_page int := greatest(coalesce(page, 1), 1);
  safe_size int := least(greatest(coalesce(page_size, 50), 1), 200);
  offset_rows int;
  total_count bigint;
  rows_json jsonb;
  needle text := nullif(trim(coalesce(q, '')), '');
begin
  offset_rows := (safe_page - 1) * safe_size;

  with filtered as (
    select v.*
    from public.voters v
    where public.voters_match_filters(v, coalesce(filters, '{}'::jsonb))
      and (
        needle is null
        or v.murmuration_id ilike '%' || needle || '%'
        or v.voter_id ilike '%' || needle || '%'
        or v.first_name ilike '%' || needle || '%'
        or v.last_name ilike '%' || needle || '%'
        or (coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')) ilike '%' || needle || '%'
        or v.address_line_1 ilike '%' || needle || '%'
        or v.city ilike '%' || needle || '%'
        or v.zip ilike '%' || needle || '%'
        or v.email ilike '%' || needle || '%'
        or v.phone ilike '%' || needle || '%'
      )
  )
  select count(*) into total_count from filtered;

  with filtered as (
    select v.*
    from public.voters v
    where public.voters_match_filters(v, coalesce(filters, '{}'::jsonb))
      and (
        needle is null
        or v.murmuration_id ilike '%' || needle || '%'
        or v.voter_id ilike '%' || needle || '%'
        or v.first_name ilike '%' || needle || '%'
        or v.last_name ilike '%' || needle || '%'
        or (coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')) ilike '%' || needle || '%'
        or v.address_line_1 ilike '%' || needle || '%'
        or v.city ilike '%' || needle || '%'
        or v.zip ilike '%' || needle || '%'
        or v.email ilike '%' || needle || '%'
        or v.phone ilike '%' || needle || '%'
      )
  )
  select coalesce(
    jsonb_agg(to_jsonb(t) order by t.last_name nulls last, t.first_name nulls last, t.id),
    '[]'::jsonb
  )
  into rows_json
  from (
    select
      id, murmuration_id, voter_id, first_name, last_name, email, phone,
      address_line_1, city, state, zip, county, party,
      age, status, support_score, lat, lng
    from filtered
    order by last_name nulls last, first_name nulls last, id
    offset offset_rows
    limit safe_size
  ) t;

  return jsonb_build_object(
    'rows', rows_json,
    'total', total_count,
    'page', safe_page,
    'page_size', safe_size
  );
end;
$$;

create or replace function public.voter_map_points(
  filters jsonb default '{}'::jsonb,
  lim int default 2500
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  safe_limit int := least(greatest(coalesce(lim, 2500), 1), 8000);
  total_with_coords bigint;
  rows_json jsonb;
begin
  select count(*) into total_with_coords
  from public.voters v
  where public.voters_match_filters(v, coalesce(filters, '{}'::jsonb))
    and v.lat is not null
    and v.lng is not null;

  select coalesce(
    jsonb_agg(to_jsonb(t) order by t.id),
    '[]'::jsonb
  )
  into rows_json
  from (
    select
      id,
      murmuration_id,
      voter_id,
      first_name,
      last_name,
      address_line_1,
      city,
      county,
      zip,
      party,
      status,
      age,
      support_score,
      lat,
      lng
    from public.voters v
    where public.voters_match_filters(v, coalesce(filters, '{}'::jsonb))
      and v.lat is not null
      and v.lng is not null
    order by v.id
    limit safe_limit
  ) t;

  return jsonb_build_object(
    'points', rows_json,
    'returned', jsonb_array_length(rows_json),
    'total_with_coords', total_with_coords,
    'truncated', total_with_coords > safe_limit
  );
end;
$$;
