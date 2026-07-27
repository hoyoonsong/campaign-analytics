-- Fast search: parse filters once, one scan, window count (no double full-table pass).

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
  f jsonb := coalesce(filters, '{}'::jsonb);
  safe_page int := greatest(coalesce(page, 1), 1);
  safe_size int := least(greatest(coalesce(page_size, 50), 1), 100);
  offset_rows int;
  needle text := nullif(trim(coalesce(q, '')), '');
  f_county text[];
  f_party text[];
  f_city text[];
  f_zip text[];
  f_status text[];
  f_age_min int;
  f_age_max int;
  f_support_min int;
  f_support_max int;
  f_has_coords boolean;
  total_count bigint;
  rows_json jsonb;
begin
  perform set_config('statement_timeout', '60s', true);
  offset_rows := (safe_page - 1) * safe_size;

  f_county := case
    when public._jsonb_text_array(f, 'county') is null then null
    else array(select lower(x) from unnest(public._jsonb_text_array(f, 'county')) as x)
  end;
  f_party := case
    when public._jsonb_text_array(f, 'party') is null then null
    else array(select lower(x) from unnest(public._jsonb_text_array(f, 'party')) as x)
  end;
  f_city := case
    when public._jsonb_text_array(f, 'city') is null then null
    else array(select lower(x) from unnest(public._jsonb_text_array(f, 'city')) as x)
  end;
  f_zip := public._jsonb_text_array(f, 'zip');
  f_status := case
    when public._jsonb_text_array(f, 'status') is null then null
    else array(select lower(x) from unnest(public._jsonb_text_array(f, 'status')) as x)
  end;
  f_age_min := nullif(f->>'age_min', '')::int;
  f_age_max := nullif(f->>'age_max', '')::int;
  f_support_min := nullif(f->>'support_score_min', '')::int;
  f_support_max := nullif(f->>'support_score_max', '')::int;
  f_has_coords := nullif(f->>'has_coords', '')::boolean;

  -- Unfiltered browse: avoid expensive match helper + ilike fanout.
  if needle is null
     and f_county is null and f_party is null and f_city is null
     and f_zip is null and f_status is null
     and f_age_min is null and f_age_max is null
     and f_support_min is null and f_support_max is null
     and f_has_coords is null
  then
    select count(*) into total_count from public.voters;
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
      from public.voters
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
  end if;

  with matched as (
    select
      v.id, v.murmuration_id, v.voter_id, v.first_name, v.last_name, v.email, v.phone,
      v.address_line_1, v.city, v.state, v.zip, v.county, v.party,
      v.age, v.status, v.support_score, v.lat, v.lng,
      count(*) over() as full_count
    from public.voters v
    where
      (f_county is null or lower(coalesce(v.county, '')) = any (f_county))
      and (f_party is null or lower(coalesce(v.party, '')) = any (f_party))
      and (f_city is null or lower(coalesce(v.city, '')) = any (f_city))
      and (f_zip is null or v.zip = any (f_zip))
      and (f_status is null or lower(coalesce(v.status, '')) = any (f_status))
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
      and (f_has_coords is null or not f_has_coords or (v.lat is not null and v.lng is not null))
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
    order by v.last_name nulls last, v.first_name nulls last, v.id
    offset offset_rows
    limit safe_size
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
          'lng', lng
        )
        order by last_name nulls last, first_name nulls last, id
      ),
      '[]'::jsonb
    )
  into total_count, rows_json
  from matched;

  return jsonb_build_object(
    'rows', rows_json,
    'total', coalesce(total_count, 0),
    'page', safe_page,
    'page_size', safe_size
  );
end;
$$;

revoke all on function public.voter_search(jsonb, text, int, int) from public;
grant execute on function public.voter_search(jsonb, text, int, int) to service_role;
