-- Fast absentee CSV pages. 0059 called voters_match_filters() per row
-- (re-parses jsonb + looks up election slugs every time) and the gateway
-- 500s on Target / combo exports.

create or replace function public.voter_export_page_absentee(
  filters jsonb default '{}'::jsonb,
  after_id bigint default null,
  lim int default 1000
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  f jsonb := coalesce(filters, '{}'::jsonb);
  safe_limit int := least(greatest(coalesce(lim, 1000), 1), 5000);
  need_mask bigint;
  skip_mask bigint;
  habit_mask bigint;
  min_n int;
  min_of text[];
  want_status text[];
  excl_status text[];
  want_slugs text[];
  excl_slugs text[];
  f_party text[];
  f_county text[];
  f_status text[];
  f_alignment text[];
  f_tag text[];
  x_party text[];
  x_county text[];
  x_status text[];
  x_alignment text[];
  x_tag text[];
  f_support_min int;
  f_support_max int;
  f_signed_any boolean;
  f_signed_min int;
  signed_min_mask bigint;
  need_signed bigint;
  excl_signed bigint;
  f_any_of jsonb;
  rows_json jsonb;
  next_cursor bigint;
begin
  perform set_config('statement_timeout', '20s', true);

  want_slugs := public._jsonb_text_array(f, 'absentee');
  excl_slugs := public._jsonb_text_array(f, 'exclude_absentee');
  want_status := public._jsonb_text_array(f, 'absentee_status');
  excl_status := public._jsonb_text_array(f, 'exclude_absentee_status');
  need_mask := public._absentee_mask(want_slugs);
  skip_mask := public._absentee_mask(excl_slugs);
  min_n := coalesce(nullif(f->>'absentee_min', '')::int, 0);
  min_of := public._jsonb_text_array(f, 'absentee_min_of');
  habit_mask := case
    when min_of is not null and cardinality(min_of) > 0 then public._absentee_mask(min_of)
    else (
      select coalesce(bit_or(1::bigint << e.bit_index), 0)
      from public.absentee_elections e
      where e.is_active
    )
  end;

  f_party := public._lower_text_array(public._jsonb_text_array(f, 'party'));
  f_county := public._lower_text_array(public._jsonb_text_array(f, 'county'));
  f_status := public._lower_text_array(public._jsonb_text_array(f, 'status'));
  f_alignment := public._lower_text_array(public._jsonb_text_array(f, 'alignment_label'));
  f_tag := public._lower_text_array(public._jsonb_text_array(f, 'supporter_tag'));
  x_party := public._lower_text_array(public._jsonb_text_array(f, 'exclude_party'));
  x_county := public._lower_text_array(public._jsonb_text_array(f, 'exclude_county'));
  x_status := public._lower_text_array(public._jsonb_text_array(f, 'exclude_status'));
  x_alignment := public._lower_text_array(public._jsonb_text_array(f, 'exclude_alignment_label'));
  x_tag := public._lower_text_array(public._jsonb_text_array(f, 'exclude_supporter_tag'));
  f_support_min := nullif(f->>'support_score_min', '')::int;
  f_support_max := nullif(f->>'support_score_max', '')::int;
  f_signed_any := nullif(f->>'signed_any', '')::boolean;
  f_signed_min := nullif(f->>'signed_min', '')::int;
  need_signed := public._petition_mask(public._jsonb_text_array(f, 'signed'));
  excl_signed := public._petition_mask(public._jsonb_text_array(f, 'exclude_signed'));
  signed_min_mask := coalesce(
    public._petition_mask(public._jsonb_text_array(f, 'signed_min_of')),
    0
  );
  f_any_of := f->'any_of';

  with filtered as (
    select
      v.id, v.murmuration_id, v.voter_id, v.first_name, v.last_name, v.email, v.phone, v.age,
      v.address_line_1, v.city, v.county, v.zip, v.state, v.lat, v.lng,
      v.party, v.voter_registered, v.status,
      v.sig_open_primaries, v.sig_reproductive_freedom, v.sig_achilles_petition,
      v.sig_medical_cannabis, v.sig_medical_marijuana_valid_code,
      v.sig_reproductive_freedom_valid_code,
      v.volunteer_interest, v.yard_sign, v.support_score, v.newsletter,
      v.alignment_score, v.top_main_topic, v.alignment_label,
      v.contact_tags, v.convos_candidate_support, v.convos_contact_status,
      v.donated, v.attended_event, v.supporter_tag
    from public.voters v
    where (after_id is null or v.id > after_id)
      and (need_mask = 0 or (coalesce(v.absentee_mask, 0) & need_mask) = need_mask)
      and (skip_mask = 0 or (coalesce(v.absentee_mask, 0) & skip_mask) = 0)
      and (min_n <= 0 or public._popcount(coalesce(v.absentee_mask, 0) & habit_mask) >= min_n)
      and public._arr_match(v.party, f_party, false)
      and public._arr_match(v.county, f_county, false)
      and public._arr_match(v.status, f_status, false)
      and public._arr_match(v.alignment_label, f_alignment, false)
      and public._arr_match(v.supporter_tag, f_tag, false)
      and public._arr_match(v.party, x_party, true)
      and public._arr_match(v.county, x_county, true)
      and public._arr_match(v.status, x_status, true)
      and public._arr_match(v.alignment_label, x_alignment, true)
      and public._arr_match(v.supporter_tag, x_tag, true)
      and (f_support_min is null or v.support_score >= f_support_min)
      and (f_support_max is null or v.support_score <= f_support_max)
      and (need_signed = 0 or (coalesce(v.signed_mask, 0) & need_signed) = need_signed)
      and (excl_signed = 0 or (coalesce(v.signed_mask, 0) & excl_signed) = 0)
      and (f_signed_any is null or not f_signed_any or coalesce(v.signed_mask, 0) <> 0)
      and (
        f_signed_min is null
        or f_signed_min <= 0
        or public._popcount(coalesce(v.signed_mask, 0) & signed_min_mask) >= f_signed_min
      )
      and (
        f_any_of is null
        or jsonb_typeof(f_any_of) <> 'array'
        or jsonb_array_length(f_any_of) = 0
        or public._voter_matches_any_of(v, f_any_of)
      )
      and (
        want_status is null
        or exists (
          select 1
          from public.voter_absentee_ballots b
          join public.absentee_elections e on e.id = b.election_id
          where b.voter_id = v.id
            and b.status = any (want_status)
            and (want_slugs is null or e.slug = any (want_slugs))
        )
      )
      and (
        excl_status is null
        or not exists (
          select 1
          from public.voter_absentee_ballots b
          join public.absentee_elections e on e.id = b.election_id
          where b.voter_id = v.id
            and b.status = any (excl_status)
            and (excl_slugs is null or e.slug = any (excl_slugs))
        )
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
    'rows', coalesce(rows_json, '[]'::jsonb),
    'next_cursor', case
      when jsonb_array_length(coalesce(rows_json, '[]'::jsonb)) < safe_limit then null
      else next_cursor
    end
  );
end;
$$;

revoke all on function public.voter_export_page_absentee(jsonb, bigint, int) from public;
grant execute on function public.voter_export_page_absentee(jsonb, bigint, int) to service_role;
notify pgrst, 'reload schema';
