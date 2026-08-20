-- Sure-duplicate merge + contact-priority suggestions + broader supporter tags.
--
-- Duplicates happen because murmuration_id upserts skip PII match: a voter-file
-- row (party + murmuration id) lands next to an older form/petition row for the
-- same person. Auto-merge keeps the identified row and folds the rest in.

create or replace function public._party_bucket(p text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when p is null or trim(p) = '' then null
    when p ~* 'republ|\bgop\b|(^|[^a-z])r([^a-z]|$)' then 'republican'
    when p ~* 'democrat|\bdem\b|(^|[^a-z])d([^a-z]|$)' then 'democrat'
    when p ~* 'unaffil|independ|non.?partisan|\bnpa\b|no party|none|other|libertar'
      then 'independent'
    else null
  end;
$$;

create or replace function public._merge_voter_pair(keep_id bigint, drop_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  k public.voters%rowtype;
  d public.voters%rowtype;
begin
  if keep_id is null or drop_id is null or keep_id = drop_id then
    return;
  end if;
  select * into k from public.voters where id = keep_id;
  select * into d from public.voters where id = drop_id;
  if k.id is null or d.id is null then
    return;
  end if;
  if coalesce(nullif(trim(k.murmuration_id), ''), '') <> ''
     and coalesce(nullif(trim(d.murmuration_id), ''), '') <> ''
     and trim(k.murmuration_id) is distinct from trim(d.murmuration_id)
  then
    return;
  end if;
  if coalesce(nullif(trim(k.voter_id), ''), '') <> ''
     and coalesce(nullif(trim(d.voter_id), ''), '') <> ''
     and trim(k.voter_id) is distinct from trim(d.voter_id)
  then
    return;
  end if;

  insert into public.voter_petition_signatures (
    voter_id, petition_id, raw_value, signed, import_batch_id, updated_at
  )
  select keep_id, s.petition_id, s.raw_value, s.signed, s.import_batch_id, s.updated_at
  from public.voter_petition_signatures s
  where s.voter_id = drop_id
  on conflict (voter_id, petition_id) do update
    set signed = public.voter_petition_signatures.signed or excluded.signed,
        raw_value = coalesce(public.voter_petition_signatures.raw_value, excluded.raw_value),
        updated_at = now();
  delete from public.voter_petition_signatures where voter_id = drop_id;

  begin
    delete from public.tracking_poll_responses a
    using public.tracking_poll_responses b
    where a.voter_id = keep_id
      and b.voter_id = drop_id
      and a.poll_id = b.poll_id;
    update public.tracking_poll_responses
    set voter_id = keep_id,
        person_key = 'v:' || keep_id::text
    where voter_id = drop_id;
  exception when undefined_table then
    null;
  end;

  update public.voters v
  set
    murmuration_id = coalesce(nullif(trim(v.murmuration_id), ''), nullif(trim(d.murmuration_id), '')),
    voter_id = coalesce(nullif(trim(v.voter_id), ''), nullif(trim(d.voter_id), '')),
    first_name = coalesce(nullif(trim(v.first_name), ''), d.first_name),
    last_name = coalesce(nullif(trim(v.last_name), ''), d.last_name),
    email = coalesce(nullif(trim(v.email), ''), d.email),
    phone = coalesce(nullif(trim(v.phone), ''), d.phone),
    age = coalesce(v.age, d.age),
    birth_year = coalesce(v.birth_year, d.birth_year),
    address_line_1 = coalesce(nullif(trim(v.address_line_1), ''), d.address_line_1),
    city = coalesce(nullif(trim(v.city), ''), d.city),
    county = coalesce(nullif(trim(v.county), ''), d.county),
    zip = coalesce(nullif(trim(v.zip), ''), d.zip),
    state = coalesce(v.state, d.state),
    lat = coalesce(v.lat, d.lat),
    lng = coalesce(v.lng, d.lng),
    party = coalesce(nullif(trim(v.party), ''), d.party),
    status = coalesce(nullif(trim(v.status), ''), d.status),
    voter_registered = coalesce(v.voter_registered, d.voter_registered),
    volunteer_interest = coalesce(v.volunteer_interest, d.volunteer_interest),
    yard_sign = coalesce(v.yard_sign, d.yard_sign),
    support_score = coalesce(v.support_score, d.support_score),
    newsletter = coalesce(v.newsletter, d.newsletter),
    alignment_label = coalesce(v.alignment_label, d.alignment_label),
    alignment_score = coalesce(v.alignment_score, d.alignment_score),
    contact_tags = coalesce(v.contact_tags, d.contact_tags),
    convos_candidate_support = coalesce(v.convos_candidate_support, d.convos_candidate_support),
    convos_contact_status = coalesce(v.convos_contact_status, d.convos_contact_status),
    donated = coalesce(v.donated, d.donated),
    attended_event = coalesce(v.attended_event, d.attended_event),
    campaign_person_id = coalesce(v.campaign_person_id, d.campaign_person_id),
    is_campaign_volunteer = coalesce(v.is_campaign_volunteer, false)
      or coalesce(d.is_campaign_volunteer, false),
    supporter_tag = coalesce(v.supporter_tag, d.supporter_tag),
    signed_mask = coalesce(v.signed_mask, 0) | coalesce(d.signed_mask, 0),
    updated_at = now()
  where v.id = keep_id;

  delete from public.voters where id = drop_id;
end;
$$;

create or replace function public.auto_merge_sure_duplicates()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '300s'
set jit = off
as $$
declare
  merged int := 0;
  skipped int := 0;
  rec record;
begin
  create temporary table if not exists _merge_pairs (
    keep_id bigint not null,
    drop_id bigint not null,
    reason text,
    primary key (drop_id)
  ) on commit drop;
  truncate _merge_pairs;

  insert into _merge_pairs (keep_id, drop_id, reason)
  select distinct on (x.drop_id) x.keep_id, x.drop_id, x.reason
  from (
    select
      first_value(v.id) over (
        partition by g.nk, g.ak
        order by
          (coalesce(nullif(trim(v.murmuration_id), ''), '') <> '') desc,
          (coalesce(nullif(trim(v.party), ''), '') <> '') desc,
          (coalesce(v.signed_mask, 0) <> 0) desc,
          v.id
      ) as keep_id,
      v.id as drop_id,
      'name+address' as reason
    from public.voters v
    join (
      select
        public._norm_name(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))) as nk,
        public._norm_address(address_line_1) as ak
      from public.voters
      where coalesce(trim(first_name), '') <> ''
        and coalesce(trim(last_name), '') <> ''
        and length(coalesce(trim(address_line_1), '')) >= 6
      group by 1, 2
      having count(*) > 1
        and count(distinct nullif(trim(murmuration_id), '')) <= 1
        and count(distinct nullif(trim(voter_id), '')) <= 1
    ) g on public._norm_name(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, ''))) = g.nk
      and public._norm_address(v.address_line_1) = g.ak
  ) x
  where x.keep_id <> x.drop_id
  on conflict (drop_id) do nothing;

  insert into _merge_pairs (keep_id, drop_id, reason)
  select distinct on (x.drop_id) x.keep_id, x.drop_id, x.reason
  from (
    select
      first_value(v.id) over (
        partition by g.nk, g.by
        order by
          (coalesce(nullif(trim(v.murmuration_id), ''), '') <> '') desc,
          (coalesce(nullif(trim(v.party), ''), '') <> '') desc,
          (coalesce(v.signed_mask, 0) <> 0) desc,
          v.id
      ) as keep_id,
      v.id as drop_id,
      'name+birth_year' as reason
    from public.voters v
    join (
      select
        public._norm_name(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))) as nk,
        birth_year as by
      from public.voters
      where coalesce(trim(first_name), '') <> ''
        and coalesce(trim(last_name), '') <> ''
        and birth_year is not null
      group by 1, 2
      having count(*) > 1
        and count(distinct nullif(trim(murmuration_id), '')) <= 1
        and count(distinct nullif(trim(voter_id), '')) <= 1
    ) g on public._norm_name(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, ''))) = g.nk
      and v.birth_year = g.by
  ) x
  where x.keep_id <> x.drop_id
  on conflict (drop_id) do nothing;

  insert into _merge_pairs (keep_id, drop_id, reason)
  select distinct on (x.drop_id) x.keep_id, x.drop_id, x.reason
  from (
    select
      first_value(v.id) over (
        partition by g.ek, g.nk
        order by
          (coalesce(nullif(trim(v.murmuration_id), ''), '') <> '') desc,
          (coalesce(nullif(trim(v.party), ''), '') <> '') desc,
          (coalesce(v.signed_mask, 0) <> 0) desc,
          v.id
      ) as keep_id,
      v.id as drop_id,
      'email+name' as reason
    from public.voters v
    join (
      select
        lower(trim(email)) as ek,
        public._norm_name(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))) as nk
      from public.voters
      where email is not null and length(trim(email)) >= 5
        and coalesce(trim(first_name), '') <> ''
        and coalesce(trim(last_name), '') <> ''
      group by 1, 2
      having count(*) > 1
        and count(distinct nullif(trim(murmuration_id), '')) <= 1
        and count(distinct nullif(trim(voter_id), '')) <= 1
    ) g on lower(trim(v.email)) = g.ek
      and public._norm_name(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, ''))) = g.nk
  ) x
  where x.keep_id <> x.drop_id
  on conflict (drop_id) do nothing;

  insert into _merge_pairs (keep_id, drop_id, reason)
  select distinct on (x.drop_id) x.keep_id, x.drop_id, x.reason
  from (
    select
      first_value(v.id) over (
        partition by g.pk, g.nk
        order by
          (coalesce(nullif(trim(v.murmuration_id), ''), '') <> '') desc,
          (coalesce(nullif(trim(v.party), ''), '') <> '') desc,
          (coalesce(v.signed_mask, 0) <> 0) desc,
          v.id
      ) as keep_id,
      v.id as drop_id,
      'phone+name' as reason
    from public.voters v
    join (
      select
        right(public._phone_digits(phone), 10) as pk,
        public._norm_name(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))) as nk
      from public.voters
      where length(coalesce(public._phone_digits(phone), '')) >= 10
        and coalesce(trim(first_name), '') <> ''
        and coalesce(trim(last_name), '') <> ''
      group by 1, 2
      having count(*) > 1
        and count(distinct nullif(trim(murmuration_id), '')) <= 1
        and count(distinct nullif(trim(voter_id), '')) <= 1
    ) g on right(public._phone_digits(v.phone), 10) = g.pk
      and public._norm_name(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, ''))) = g.nk
  ) x
  where x.keep_id <> x.drop_id
  on conflict (drop_id) do nothing;

  for rec in
    select keep_id, drop_id from _merge_pairs order by drop_id
  loop
    begin
      perform public._merge_voter_pair(rec.keep_id, rec.drop_id);
      merged := merged + 1;
    exception when others then
      skipped := skipped + 1;
    end;
    exit when merged >= 5000;
  end loop;

  begin
    perform public.mark_possible_duplicates_stale();
  exception when undefined_function then
    null;
  end;

  return jsonb_build_object('merged', merged, 'skipped', skipped);
end;
$$;

create or replace function public.contact_suggestions(
  p_party text default null,
  p_signed_min integer default 1,
  p_page integer default 1,
  p_page_size integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set statement_timeout = '60s'
set jit = off
as $$
declare
  safe_page int := greatest(coalesce(p_page, 1), 1);
  safe_size int := least(greatest(coalesce(p_page_size, 50), 1), 100);
  want_party text := nullif(lower(trim(coalesce(p_party, ''))), '');
  min_signed int := greatest(coalesce(p_signed_min, 1), 1);
  offset_rows int;
  total_count bigint;
  rows_json jsonb;
  counts jsonb;
begin
  offset_rows := (safe_page - 1) * safe_size;

  select jsonb_build_object(
    'all', count(*)::int,
    'republican', count(*) filter (where public._party_bucket(v.party) = 'republican')::int,
    'democrat', count(*) filter (where public._party_bucket(v.party) = 'democrat')::int,
    'independent', count(*) filter (where public._party_bucket(v.party) = 'independent')::int,
    'super', count(*) filter (where public._popcount(v.signed_mask) >= 2)::int
  )
  into counts
  from public.voters v
  where coalesce(lower(trim(v.supporter_tag)), '') not in ('supporter', 'maybe', 'opposed')
    and v.signed_mask <> 0;

  select count(*) into total_count
  from public.voters v
  where coalesce(lower(trim(v.supporter_tag)), '') not in ('supporter', 'maybe', 'opposed')
    and public._popcount(v.signed_mask) >= min_signed
    and (
      want_party is null
      or public._party_bucket(v.party) = want_party
    );

  select coalesce(
    jsonb_agg(to_jsonb(t) order by t.petitions desc, t.last_name nulls last, t.id),
    '[]'::jsonb
  )
  into rows_json
  from (
    select
      v.id,
      v.first_name,
      v.last_name,
      v.email,
      v.phone,
      v.address_line_1,
      v.city,
      v.state,
      v.zip,
      v.county,
      v.party,
      v.supporter_tag,
      public._popcount(v.signed_mask) as petitions
    from public.voters v
    where coalesce(lower(trim(v.supporter_tag)), '') not in ('supporter', 'maybe', 'opposed')
      and public._popcount(v.signed_mask) >= min_signed
      and (
        want_party is null
        or public._party_bucket(v.party) = want_party
      )
    order by public._popcount(v.signed_mask) desc, v.last_name nulls last, v.id
    offset offset_rows
    limit safe_size
  ) t;

  return jsonb_build_object(
    'rows', coalesce(rows_json, '[]'::jsonb),
    'total', coalesce(total_count, 0),
    'page', safe_page,
    'page_size', safe_size,
    'counts', coalesce(counts, '{}'::jsonb)
  );
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
  n_maybe int := 0;
  n_opposed int := 0;
  n_supporter int := 0;
begin
  update public.voters set supporter_tag = null where supporter_tag is not null;

  update public.voters v
  set supporter_tag = 'maybe'
  where
    lower(coalesce(v.alignment_label, '')) = 'neutral'
    or lower(coalesce(v.convos_candidate_support, '')) = 'maybe'
    or lower(coalesce(v.convos_poll_question, '')) = 'c) not sure'
    or v.support_score = 3;
  get diagnostics n_maybe = row_count;

  update public.voters v
  set supporter_tag = 'opposed'
  where
    lower(coalesce(v.convos_candidate_support, '')) = 'no'
    or lower(coalesce(v.alignment_label, '')) = 'negative'
    or v.support_score in (4, 5);
  get diagnostics n_opposed = row_count;

  update public.voters v
  set supporter_tag = 'supporter'
  where
    lower(coalesce(v.yard_sign, '')) in ('yes', 'delivered')
    or lower(coalesce(v.donated, '')) = 'yes'
    or lower(coalesce(v.alignment_label, '')) = 'positive'
    or v.support_score in (1, 2)
    or lower(coalesce(v.convos_candidate_support, '')) = 'yes'
    or lower(coalesce(v.volunteer_interest, '')) in ('yes', 'y')
    or lower(coalesce(v.attended_event, '')) in ('yes', 'y')
    or lower(coalesce(v.newsletter, '')) in ('yes', 'y')
    or v.is_campaign_volunteer;
  get diagnostics n_supporter = row_count;

  return jsonb_build_object(
    'maybe', n_maybe,
    'opposed', n_opposed,
    'supporter', n_supporter,
    'tagged_voters', (select count(*)::int from public.voters where supporter_tag is not null)
  );
end;
$$;

create index if not exists voters_signed_untagged_idx
  on public.voters (signed_mask)
  where signed_mask <> 0
    and coalesce(lower(trim(supporter_tag)), '') not in ('supporter', 'maybe', 'opposed');

-- Before murmuration upsert: stamp the ID onto an existing ID-less PII match
-- so ON CONFLICT updates that row instead of inserting a twin.
create or replace function public.voter_attach_ids_by_pii(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
set jit = off
as $$
declare
  attached int := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('attached', 0);
  end if;

  drop table if exists _in_ids;
  create temporary table _in_ids on commit drop as
  select distinct on (mid)
    mid,
    public._norm_name(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))) as nk,
    public._norm_address(address_line_1) as ak,
    nullif(lower(trim(email)), '') as ek,
    case
      when length(coalesce(public._phone_digits(phone), '')) >= 10
        then right(public._phone_digits(phone), 10)
      else null
    end as pk,
    birth_year as by
  from (
    select
      nullif(trim(r->>'murmuration_id'), '') as mid,
      r->>'first_name' as first_name,
      r->>'last_name' as last_name,
      coalesce(r->>'address_line_1', r->>'address') as address_line_1,
      r->>'email' as email,
      r->>'phone' as phone,
      case
        when jsonb_typeof(r->'birth_year') = 'number' then (r->>'birth_year')::int
        when r->>'birth_year' ~ '^[0-9]{4}$' then (r->>'birth_year')::int
        else null
      end as birth_year
    from jsonb_array_elements(p_rows) r
  ) x
  where mid is not null
    and not exists (
      select 1 from public.voters v where v.murmuration_id = x.mid
    );

  update public.voters v
  set murmuration_id = m.mid,
      updated_at = now()
  from (
    select distinct on (s.id) s.id, s.mid
    from (
      select distinct on (i.mid) v2.id, i.mid
      from _in_ids i
      join public.voters v2
        on (v2.murmuration_id is null or v2.murmuration_id = '')
        and i.nk <> ''
        and public._norm_name(trim(coalesce(v2.first_name, '') || ' ' || coalesce(v2.last_name, ''))) = i.nk
        and (
          (i.ak is not null and length(i.ak) >= 6
            and public._norm_address(v2.address_line_1) = i.ak)
          or (i.ek is not null and length(i.ek) >= 5
            and lower(trim(v2.email)) = i.ek)
          or (i.pk is not null and right(public._phone_digits(v2.phone), 10) = i.pk)
          or (i.by is not null and v2.birth_year = i.by)
        )
      order by i.mid, v2.id
    ) s
    order by s.id, s.mid
  ) m
  where v.id = m.id
    and (v.murmuration_id is null or v.murmuration_id = '')
    and not exists (
      select 1 from public.voters x where x.murmuration_id = m.mid
    );

  get diagnostics attached = row_count;
  return jsonb_build_object('attached', attached);
end;
$$;

-- Match FormHandler people by Murmuration ID, then email, then phone.
create or replace function public.apply_campaign_lean_sync(
  p_contacts jsonb,
  p_geo jsonb,
  p_volunteer_count int default 0,
  p_yard_sign_count int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_geo_count int := 0;
  v_matched int := 0;
begin
  perform set_config('statement_timeout', '120s', true);

  truncate public.campaign_person_contacts;
  truncate public.campaign_geo_points;

  insert into public.campaign_person_contacts (person_id, email, phone_digits, is_volunteer)
  select
    (c->>'person_id')::uuid,
    nullif(lower(trim(c->>'email')), ''),
    nullif(c->>'phone_digits', ''),
    coalesce((c->>'is_volunteer')::boolean, false)
  from jsonb_array_elements(coalesce(p_contacts, '[]'::jsonb)) c
  where c->>'person_id' is not null
    and (
      nullif(lower(trim(c->>'email')), '') is not null
      or nullif(c->>'phone_digits', '') is not null
    );

  insert into public.campaign_geo_points (source_id, kind, lat, lng, name, email, phone, address)
  select distinct on (kind, source_id)
    source_id, kind, lat, lng, name, email, phone, address
  from (
    select
      (g->>'source_id')::uuid as source_id,
      g->>'kind' as kind,
      (g->>'lat')::double precision as lat,
      (g->>'lng')::double precision as lng,
      nullif(trim(g->>'name'), '') as name,
      nullif(lower(trim(g->>'email')), '') as email,
      nullif(trim(g->>'phone'), '') as phone,
      nullif(trim(g->>'address'), '') as address
    from jsonb_array_elements(coalesce(p_geo, '[]'::jsonb)) g
    where g->>'source_id' is not null
      and g->>'kind' in ('volunteer', 'yard_sign')
      and g->>'lat' is not null
      and g->>'lng' is not null
  ) s
  order by kind, source_id;

  get diagnostics v_geo_count = row_count;

  update public.voters
  set is_campaign_volunteer = false,
      campaign_person_id = null
  where is_campaign_volunteer
     or campaign_person_id is not null;

  update public.voters v
  set
    campaign_person_id = m.person_id,
    is_campaign_volunteer = v.is_campaign_volunteer or m.is_volunteer
  from (
    select distinct on (mid)
      mid,
      person_id,
      is_volunteer
    from (
      select
        nullif(trim(c->>'murmuration_id'), '') as mid,
        (c->>'person_id')::uuid as person_id,
        coalesce((c->>'is_volunteer')::boolean, false) as is_volunteer
      from jsonb_array_elements(coalesce(p_contacts, '[]'::jsonb)) c
      where c->>'person_id' is not null
    ) x
    where mid is not null
    order by mid, is_volunteer desc, person_id
  ) m
  where v.murmuration_id is not null
    and trim(v.murmuration_id) = m.mid;

  update public.voters v
  set
    campaign_person_id = ep.person_id,
    is_campaign_volunteer = ev.is_volunteer
  from (
    select distinct on (email) email, person_id
    from public.campaign_person_contacts
    where email is not null
    order by email, is_volunteer desc, person_id
  ) ep
  join (
    select email, bool_or(is_volunteer) as is_volunteer
    from public.campaign_person_contacts
    where email is not null
    group by email
  ) ev on ev.email = ep.email
  where v.campaign_person_id is null
    and v.email is not null
    and lower(v.email) = ep.email;

  update public.voters v
  set
    campaign_person_id = ep.person_id,
    is_campaign_volunteer = v.is_campaign_volunteer or ev.is_volunteer
  from (
    select distinct on (phone_digits) phone_digits, person_id
    from public.campaign_person_contacts
    where phone_digits is not null
    order by phone_digits, is_volunteer desc, person_id
  ) ep
  join (
    select phone_digits, bool_or(is_volunteer) as is_volunteer
    from public.campaign_person_contacts
    where phone_digits is not null
    group by phone_digits
  ) ev on ev.phone_digits = ep.phone_digits
  where v.campaign_person_id is null
    and v.phone is not null
    and public._phone_digits(v.phone) = ep.phone_digits;

  update public.voters v
  set is_campaign_volunteer = true
  from public.campaign_person_contacts c
  where not v.is_campaign_volunteer
    and c.is_volunteer
    and (
      (v.email is not null and c.email is not null and lower(v.email) = c.email)
      or (
        v.phone is not null
        and c.phone_digits is not null
        and public._phone_digits(v.phone) = c.phone_digits
      )
    );

  select count(*)::int into v_matched
  from public.voters
  where campaign_person_id is not null or is_campaign_volunteer;

  update public.campaign_sync_state set
    last_success_at = now(),
    volunteer_count = coalesce(p_volunteer_count, 0),
    yard_sign_count = coalesce(p_yard_sign_count, 0),
    matched_voter_count = v_matched,
    geo_point_count = v_geo_count,
    last_error = null,
    updated_at = now()
  where id = 1;

  return jsonb_build_object(
    'geo_point_count', v_geo_count,
    'matched_voter_count', v_matched,
    'contact_rows', (select count(*)::int from public.campaign_person_contacts)
  );
end;
$$;

revoke all on function public._merge_voter_pair(bigint, bigint) from public;
revoke all on function public.auto_merge_sure_duplicates() from public;
revoke all on function public.contact_suggestions(text, integer, integer, integer) from public;
revoke all on function public.voter_attach_ids_by_pii(jsonb) from public;
grant execute on function public.auto_merge_sure_duplicates() to service_role;
grant execute on function public.contact_suggestions(text, integer, integer, integer) to service_role;
grant execute on function public.recompute_supporter_tags() to service_role;
grant execute on function public._party_bucket(text) to service_role;
grant execute on function public.voter_attach_ids_by_pii(jsonb) to service_role;
grant execute on function public.apply_campaign_lean_sync(jsonb, jsonb, int, int) to service_role;
