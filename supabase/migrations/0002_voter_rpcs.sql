-- Shared filter predicate helpers and analytics / search / export / map / usage RPCs.
-- All aggregation stays in Postgres.

create or replace function public._jsonb_text_array(j jsonb, key text)
returns text[]
language sql
immutable
as $$
  select case
    when j is null or not (j ? key) or j->key is null or j->key = 'null'::jsonb then null
    when jsonb_typeof(j->key) = 'array' then array(
      select jsonb_array_elements_text(j->key)
    )
    when jsonb_typeof(j->key) = 'string' and nullif(j->>key, '') is not null
      then array[j->>key]
    else null
  end;
$$;

create or replace function public.voters_match_filters(v public.voters, filters jsonb)
returns boolean
language sql
stable
as $$
  select
    (
      public._jsonb_text_array(filters, 'county') is null
      or v.county = any (public._jsonb_text_array(filters, 'county'))
    )
    and (
      public._jsonb_text_array(filters, 'party') is null
      or v.party = any (public._jsonb_text_array(filters, 'party'))
    )
    and (
      public._jsonb_text_array(filters, 'city') is null
      or v.city = any (public._jsonb_text_array(filters, 'city'))
    )
    and (
      public._jsonb_text_array(filters, 'zip') is null
      or v.zip = any (public._jsonb_text_array(filters, 'zip'))
    )
    and (
      public._jsonb_text_array(filters, 'status') is null
      or v.status = any (public._jsonb_text_array(filters, 'status'))
    )
    and (
      (filters->>'age_min') is null
      or nullif(filters->>'age_min', '') is null
      or (
        coalesce(
          v.age,
          case when v.birth_year is not null
            then extract(year from current_date)::int - v.birth_year
          end
        ) >= (filters->>'age_min')::int
      )
    )
    and (
      (filters->>'age_max') is null
      or nullif(filters->>'age_max', '') is null
      or (
        coalesce(
          v.age,
          case when v.birth_year is not null
            then extract(year from current_date)::int - v.birth_year
          end
        ) <= (filters->>'age_max')::int
      )
    )
    and (
      (filters->>'support_score_min') is null
      or nullif(filters->>'support_score_min', '') is null
      or (v.support_score is not null and v.support_score >= (filters->>'support_score_min')::int)
    )
    and (
      (filters->>'support_score_max') is null
      or nullif(filters->>'support_score_max', '') is null
      or (v.support_score is not null and v.support_score <= (filters->>'support_score_max')::int)
    )
    and (
      (filters->>'has_coords') is null
      or nullif(filters->>'has_coords', '') is null
      or (
        case when (filters->>'has_coords')::boolean
          then v.lat is not null and v.lng is not null
          else true
        end
      )
    );
$$;

create or replace function public.voter_analytics_summary(filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  with filtered as (
    select *
    from public.voters v
    where public.voters_match_filters(v, coalesce(filters, '{}'::jsonb))
  ),
  totals as (
    select count(*)::bigint as total from filtered
  ),
  by_county as (
    select coalesce(nullif(county, ''), '(blank)') as key, count(*)::bigint as count
    from filtered
    group by 1
    order by count desc, key
  ),
  by_party as (
    select coalesce(nullif(party, ''), '(blank)') as key, count(*)::bigint as count
    from filtered
    group by 1
    order by count desc, key
  ),
  by_status as (
    select coalesce(nullif(status, ''), '(blank)') as key, count(*)::bigint as count
    from filtered
    group by 1
    order by count desc, key
  ),
  by_age as (
    select
      case
        when coalesce(age, case when birth_year is not null
          then extract(year from current_date)::int - birth_year end) is null then 'Unknown'
        when coalesce(age, extract(year from current_date)::int - birth_year) < 18 then 'Under 18'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 18 and 24 then '18–24'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 25 and 34 then '25–34'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 35 and 44 then '35–44'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 45 and 54 then '45–54'
        when coalesce(age, extract(year from current_date)::int - birth_year) between 55 and 64 then '55–64'
        else '65+'
      end as key,
      count(*)::bigint as count
    from filtered
    group by 1
  ),
  with_coords as (
    select count(*)::bigint as n
    from filtered
    where lat is not null and lng is not null
  )
  select jsonb_build_object(
    'total', (select total from totals),
    'with_coords', (select n from with_coords),
    'by_county', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_county), '[]'::jsonb),
    'by_party', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_party), '[]'::jsonb),
    'by_status', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_status), '[]'::jsonb),
    'by_age', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'count', count)) from by_age), '[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

-- Map pins: server-side filtered page of points only (never full table dump).
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
      id, voter_id, first_name, last_name, email, phone,
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

create or replace function public.voter_export_page(
  filters jsonb default '{}'::jsonb,
  after_id bigint default null,
  lim int default 1000
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  safe_limit int := least(greatest(coalesce(lim, 1000), 1), 5000);
  rows_json jsonb;
  next_cursor bigint;
begin
  with filtered as (
    select
      id, voter_id, first_name, last_name, email, phone, age,
      address_line_1, city, county, zip, state, lat, lng,
      party, voter_registered, status,
      sig_open_primaries, sig_reproductive_freedom, sig_achilles_petition,
      sig_medical_cannabis, sig_medical_marijuana_valid_code,
      sig_reproductive_freedom_valid_code,
      volunteer_interest, yard_sign, support_score, newsletter,
      legacy_volunteer, alignment_score, top_main_topic, alignment_label,
      contact_tags, convos_candidate_support, convos_contact_status,
      convos_poll_question, donated, attended_event
    from public.voters v
    where public.voters_match_filters(v, coalesce(filters, '{}'::jsonb))
      and (after_id is null or v.id > after_id)
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

create or replace function public.voter_db_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  voter_count bigint;
  table_bytes bigint;
  index_bytes bigint;
  total_bytes bigint;
  db_bytes bigint;
begin
  select count(*) into voter_count from public.voters;
  select pg_relation_size('public.voters') into table_bytes;
  select pg_indexes_size('public.voters') into index_bytes;
  select pg_total_relation_size('public.voters') into total_bytes;
  select pg_database_size(current_database()) into db_bytes;

  return jsonb_build_object(
    'voter_count', voter_count,
    'table_size', pg_size_pretty(table_bytes),
    'index_size', pg_size_pretty(index_bytes),
    'total_relation_size', pg_size_pretty(total_bytes),
    'database_size', pg_size_pretty(db_bytes),
    'table_size_bytes', table_bytes,
    'index_size_bytes', index_bytes,
    'total_relation_size_bytes', total_bytes,
    'database_size_bytes', db_bytes
  );
end;
$$;

create or replace function public.voter_filter_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return jsonb_build_object(
    'counties', coalesce((
      select jsonb_agg(c order by c)
      from (select distinct county as c from public.voters where county is not null and county <> '') s
    ), '[]'::jsonb),
    'parties', coalesce((
      select jsonb_agg(c order by c)
      from (select distinct party as c from public.voters where party is not null and party <> '') s
    ), '[]'::jsonb),
    'statuses', coalesce((
      select jsonb_agg(c order by c)
      from (select distinct status as c from public.voters where status is not null and status <> '') s
    ), '[]'::jsonb),
    'cities', coalesce((
      select jsonb_agg(c order by c)
      from (select distinct city as c from public.voters where city is not null and city <> '') s
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.voter_analytics_summary(jsonb) from public;
revoke all on function public.voter_map_points(jsonb, int) from public;
revoke all on function public.voter_search(jsonb, text, int, int) from public;
revoke all on function public.voter_export_page(jsonb, bigint, int) from public;
revoke all on function public.voter_db_usage() from public;
revoke all on function public.voter_filter_options() from public;

grant execute on function public.voter_analytics_summary(jsonb) to service_role;
grant execute on function public.voter_map_points(jsonb, int) to service_role;
grant execute on function public.voter_search(jsonb, text, int, int) to service_role;
grant execute on function public.voter_export_page(jsonb, bigint, int) to service_role;
grant execute on function public.voter_db_usage() to service_role;
grant execute on function public.voter_filter_options() to service_role;
