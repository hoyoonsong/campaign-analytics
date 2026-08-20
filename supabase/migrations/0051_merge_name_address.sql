-- Auto-merge was skipping the obvious twins (same name + street, one row
-- with party / Murmuration ID and one without) because the group filter
-- required the whole household to share a single murmuration_id AND voter_id.
-- Search's possible-duplicates list does not. Match that list.

create or replace function public._merge_voter_pair(keep_id bigint, drop_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  k public.voters%rowtype;
  d public.voters%rowtype;
  drop_mid text;
  drop_vid text;
begin
  if keep_id is null or drop_id is null or keep_id = drop_id then
    return;
  end if;
  select * into k from public.voters where id = keep_id;
  select * into d from public.voters where id = drop_id;
  if k.id is null or d.id is null then
    return;
  end if;

  drop_mid := nullif(trim(d.murmuration_id), '');
  drop_vid := nullif(trim(d.voter_id), '');

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

  -- Free unique keys on the loser first so keep can absorb them.
  update public.voters
  set murmuration_id = null,
      voter_id = null
  where id = drop_id;

  update public.voters v
  set
    murmuration_id = coalesce(
      nullif(trim(v.murmuration_id), ''),
      drop_mid
    ),
    voter_id = case
      when coalesce(nullif(trim(v.voter_id), ''), '') <> '' then v.voter_id
      when drop_vid is null then v.voter_id
      when exists (
        select 1 from public.voters o
        where o.id <> keep_id
          and o.id <> drop_id
          and o.voter_id = drop_vid
      ) then v.voter_id
      else drop_vid
    end,
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
  found int := 0;
  rec record;
begin
  drop table if exists _merge_pairs;
  create temporary table _merge_pairs (
    keep_id bigint not null,
    drop_id bigint not null,
    reason text,
    primary key (drop_id)
  ) on commit drop;

  -- Same Murmuration ID (case / whitespace variants). Unique index is
  -- case-sensitive, so these twins can both exist.
  insert into _merge_pairs (keep_id, drop_id, reason)
  select distinct on (x.drop_id) x.keep_id, x.drop_id, 'murmuration_id'
  from (
    select
      first_value(v.id) over (
        partition by g.mid
        order by
          (coalesce(nullif(trim(v.party), ''), '') <> '') desc,
          (coalesce(v.signed_mask, 0) <> 0) desc,
          v.id
      ) as keep_id,
      v.id as drop_id
    from public.voters v
    join (
      select lower(trim(murmuration_id)) as mid
      from public.voters
      where coalesce(trim(murmuration_id), '') <> ''
      group by 1
      having count(*) > 1
    ) g on lower(trim(v.murmuration_id)) = g.mid
  ) x
  where x.keep_id <> x.drop_id
  on conflict (drop_id) do nothing;

  -- Same first + last + street — the Search duplicate list.
  insert into _merge_pairs (keep_id, drop_id, reason)
  select distinct on (x.drop_id) x.keep_id, x.drop_id, 'name+address'
  from (
    select
      first_value(v.id) over (
        partition by g.fn, g.ln, g.addr
        order by
          (coalesce(nullif(trim(v.murmuration_id), ''), '') <> '') desc,
          (coalesce(nullif(trim(v.party), ''), '') <> '') desc,
          (coalesce(v.signed_mask, 0) <> 0) desc,
          v.id
      ) as keep_id,
      v.id as drop_id
    from public.voters v
    join (
      select
        lower(trim(first_name)) as fn,
        lower(trim(last_name)) as ln,
        lower(trim(address_line_1)) as addr
      from public.voters
      where coalesce(trim(first_name), '') <> ''
        and coalesce(trim(last_name), '') <> ''
        and coalesce(trim(address_line_1), '') <> ''
      group by 1, 2, 3
      having count(*) > 1
    ) g on lower(trim(v.first_name)) = g.fn
      and lower(trim(v.last_name)) = g.ln
      and lower(trim(v.address_line_1)) = g.addr
  ) x
  where x.keep_id <> x.drop_id
  on conflict (drop_id) do nothing;

  -- Punctuation-normalized street (853 E. vs 853 E).
  insert into _merge_pairs (keep_id, drop_id, reason)
  select distinct on (x.drop_id) x.keep_id, x.drop_id, 'name+address_norm'
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
      v.id as drop_id
    from public.voters v
    join (
      select
        public._norm_name(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))) as nk,
        public._norm_address(address_line_1) as ak
      from public.voters
      where coalesce(trim(first_name), '') <> ''
        and coalesce(trim(last_name), '') <> ''
        and public._norm_address(address_line_1) is not null
      group by 1, 2
      having count(*) > 1
    ) g on public._norm_name(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, ''))) = g.nk
      and public._norm_address(v.address_line_1) = g.ak
  ) x
  where x.keep_id <> x.drop_id
  on conflict (drop_id) do nothing;

  insert into _merge_pairs (keep_id, drop_id, reason)
  select distinct on (x.drop_id) x.keep_id, x.drop_id, 'name+birth_year'
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
      v.id as drop_id
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
    ) g on public._norm_name(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, ''))) = g.nk
      and v.birth_year = g.by
  ) x
  where x.keep_id <> x.drop_id
  on conflict (drop_id) do nothing;

  insert into _merge_pairs (keep_id, drop_id, reason)
  select distinct on (x.drop_id) x.keep_id, x.drop_id, 'email+name'
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
      v.id as drop_id
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
    ) g on lower(trim(v.email)) = g.ek
      and public._norm_name(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, ''))) = g.nk
  ) x
  where x.keep_id <> x.drop_id
  on conflict (drop_id) do nothing;

  insert into _merge_pairs (keep_id, drop_id, reason)
  select distinct on (x.drop_id) x.keep_id, x.drop_id, 'phone+name'
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
      v.id as drop_id
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
    ) g on right(public._phone_digits(v.phone), 10) = g.pk
      and public._norm_name(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, ''))) = g.nk
  ) x
  where x.keep_id <> x.drop_id
  on conflict (drop_id) do nothing;

  select count(*) into found from _merge_pairs;

  for rec in
    select keep_id, drop_id from _merge_pairs order by drop_id
  loop
    begin
      perform public._merge_voter_pair(rec.keep_id, rec.drop_id);
      if exists (select 1 from public.voters where id = rec.drop_id) then
        skipped := skipped + 1;
      else
        merged := merged + 1;
      end if;
    exception when others then
      skipped := skipped + 1;
    end;
    exit when merged >= 20000;
  end loop;

  begin
    perform public.mark_possible_duplicates_stale();
  exception when undefined_function then
    null;
  end;

  return jsonb_build_object(
    'merged', merged,
    'skipped', skipped,
    'found', found
  );
end;
$$;

revoke all on function public._merge_voter_pair(bigint, bigint) from public;
revoke all on function public.auto_merge_sure_duplicates() from public;
grant execute on function public.auto_merge_sure_duplicates() to service_role;
