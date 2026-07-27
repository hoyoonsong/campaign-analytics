-- Efficient import upsert (fill-in merge) + profile fetch + match lookup.
-- Designed for Supabase free tier: no full-table client loads.
--
-- First upgrade older `voters` tables (pre-PDI schema) so columns exist.

alter table public.voters add column if not exists murmuration_id text;
alter table public.voters add column if not exists email text;
alter table public.voters add column if not exists phone text;
alter table public.voters add column if not exists age smallint;
alter table public.voters add column if not exists birth_year smallint;
alter table public.voters add column if not exists lat double precision;
alter table public.voters add column if not exists lng double precision;
alter table public.voters add column if not exists voter_registered text;
alter table public.voters add column if not exists sig_open_primaries text;
alter table public.voters add column if not exists sig_reproductive_freedom text;
alter table public.voters add column if not exists sig_achilles_petition text;
alter table public.voters add column if not exists sig_medical_cannabis text;
alter table public.voters add column if not exists sig_medical_marijuana_valid_code text;
alter table public.voters add column if not exists sig_reproductive_freedom_valid_code text;
alter table public.voters add column if not exists volunteer_interest text;
alter table public.voters add column if not exists yard_sign text;
alter table public.voters add column if not exists support_score smallint;
alter table public.voters add column if not exists newsletter text;
alter table public.voters add column if not exists legacy_volunteer text;
alter table public.voters add column if not exists alignment_score text;
alter table public.voters add column if not exists top_main_topic text;
alter table public.voters add column if not exists alignment_label text;
alter table public.voters add column if not exists contact_tags text;
alter table public.voters add column if not exists convos_candidate_support text;
alter table public.voters add column if not exists convos_contact_status text;
alter table public.voters add column if not exists convos_poll_question text;
alter table public.voters add column if not exists donated text;
alter table public.voters add column if not exists attended_event text;

create index if not exists voters_email_lower_idx
  on public.voters (lower(email))
  where email is not null and email <> '';

create index if not exists voters_phone_digits_idx
  on public.voters (
    (regexp_replace(coalesce(phone, ''), '\D', '', 'g'))
  )
  where phone is not null and phone <> '';

create index if not exists voters_lat_lng_idx
  on public.voters (lat, lng)
  where lat is not null and lng is not null;

create index if not exists voters_age_idx on public.voters (age);
create index if not exists voters_support_score_idx on public.voters (support_score);

create or replace function public._norm_phone(p text)
returns text
language sql
immutable
as $$
  select case
    when length(d) = 11 and left(d, 1) = '1' then substring(d from 2)
    else d
  end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) s;
$$;

create or replace function public._norm_email(e text)
returns text
language sql
immutable
as $$
  select nullif(lower(trim(coalesce(e, ''))), '');
$$;

create or replace function public._norm_name(n text)
returns text
language sql
immutable
as $$
  select nullif(regexp_replace(lower(trim(coalesce(n, ''))), '\s+', ' ', 'g'), '');
$$;

create or replace function public._norm_address(a text)
returns text
language sql
immutable
as $$
  select nullif(
    regexp_replace(
      regexp_replace(lower(trim(coalesce(a, ''))), '[.,#]', ' ', 'g'),
      '\s+', ' ', 'g'
    ),
    ''
  );
$$;

-- Fill blanks only; never wipe existing non-null with null/empty.
create or replace function public._voter_fill_in(existing public.voters, incoming jsonb)
returns public.voters
language plpgsql
immutable
as $$
declare
  out_row public.voters := existing;
  v text;
begin
  foreach v in array array[
    'first_name','last_name','email','phone','address_line_1','city','county','zip','state',
    'party','voter_registered','status',
    'sig_open_primaries','sig_reproductive_freedom','sig_achilles_petition','sig_medical_cannabis',
    'sig_medical_marijuana_valid_code','sig_reproductive_freedom_valid_code',
    'volunteer_interest','yard_sign','newsletter','legacy_volunteer',
    'alignment_score','top_main_topic','alignment_label','contact_tags',
    'convos_candidate_support','convos_contact_status','convos_poll_question',
    'donated','attended_event'
  ]
  loop
    if incoming ? v and nullif(incoming->>v, '') is not null then
      if (to_jsonb(out_row)->>v) is null or (to_jsonb(out_row)->>v) = '' then
        out_row := jsonb_populate_record(out_row, jsonb_build_object(v, incoming->>v));
      end if;
    end if;
  end loop;

  if incoming ? 'age' and nullif(incoming->>'age', '') is not null then
    if out_row.age is null then
      out_row.age := (incoming->>'age')::smallint;
    end if;
  end if;
  if incoming ? 'support_score' and nullif(incoming->>'support_score', '') is not null then
    if out_row.support_score is null then
      out_row.support_score := (incoming->>'support_score')::smallint;
    end if;
  end if;
  if incoming ? 'lat' and nullif(incoming->>'lat', '') is not null then
    if out_row.lat is null then
      out_row.lat := (incoming->>'lat')::double precision;
    end if;
  end if;
  if incoming ? 'lng' and nullif(incoming->>'lng', '') is not null then
    if out_row.lng is null then
      out_row.lng := (incoming->>'lng')::double precision;
    end if;
  end if;
  if incoming ? 'voter_id' and nullif(incoming->>'voter_id', '') is not null then
    if out_row.voter_id is null or out_row.voter_id = '' then
      out_row.voter_id := incoming->>'voter_id';
    end if;
  end if;
  if incoming ? 'murmuration_id' and nullif(incoming->>'murmuration_id', '') is not null then
    if out_row.murmuration_id is null or out_row.murmuration_id = '' then
      out_row.murmuration_id := incoming->>'murmuration_id';
    end if;
  end if;

  return out_row;
end;
$$;

create or replace function public.voter_upsert_batch(rows jsonb, batch_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  vid text;
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
      vid := nullif(trim(coalesce(item->>'voter_id', '')), '');
      email_n := public._norm_email(item->>'email');
      phone_n := public._norm_phone(item->>'phone');
      name_n := public._norm_name(
        trim(coalesce(item->>'first_name', '') || ' ' || coalesce(item->>'last_name', ''))
      );
      addr_n := public._norm_address(item->>'address_line_1');

      match_id := null;

      if vid is not null then
        select id into match_id from public.voters where voter_id = vid limit 1;
      end if;

      -- PII match only when no voter_id hit (or missing voter_id).
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

      if match_id is null and vid is null then
        -- No voter_id and no PII match — skip rather than invent duplicates.
        skipped := skipped + 1;
        continue;
      end if;

      if match_id is not null then
        select * into existing from public.voters where id = match_id;
        merged := public._voter_fill_in(existing, item);
        -- Always refresh coords/support/age when incoming has values (non-null).
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
        -- Non-blank campaign fields overwrite (field updates from new export).
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
          voter_id, first_name, last_name, email, phone, age,
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

create or replace function public.voter_get_profile(p_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(v)
  from public.voters v
  where v.id = p_id;
$$;

revoke all on function public.voter_upsert_batch(jsonb, uuid) from public;
revoke all on function public.voter_get_profile(bigint) from public;
grant execute on function public.voter_upsert_batch(jsonb, uuid) to service_role;
grant execute on function public.voter_get_profile(bigint) to service_role;
