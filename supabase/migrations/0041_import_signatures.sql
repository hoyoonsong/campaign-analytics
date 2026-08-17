-- Apply per-row signatures during import, dual-write legacy sig_* columns,
-- and helpers to create petitions with the next free bit_index.

create or replace function public.next_petition_bit_index()
returns smallint
language sql
stable
as $$
  select g.n::smallint
  from generate_series(0, 62) as g(n)
  where not exists (
    select 1 from public.petitions p where p.bit_index = g.n
  )
  order by g.n
  limit 1;
$$;

create or replace function public.create_petition(
  p_label text,
  p_slug text default null,
  p_short_label text default null,
  p_is_default boolean default false,
  p_actor text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slug text;
  v_short text;
  v_bit smallint;
  rec public.petitions;
begin
  v_slug := nullif(trim(coalesce(p_slug, '')), '');
  if v_slug is null then
    v_slug := trim(both '_' from lower(regexp_replace(coalesce(p_label, ''), '[^a-zA-Z0-9]+', '_', 'g')));
  end if;
  v_slug := left(v_slug, 64);
  if v_slug is null or v_slug = '' then
    return jsonb_build_object('error', 'label is required');
  end if;

  select * into rec from public.petitions where slug = v_slug;
  if found then
    return to_jsonb(rec);
  end if;

  v_bit := public.next_petition_bit_index();
  if v_bit is null then
    return jsonb_build_object('error', 'No free petition bit_index (max 63)');
  end if;

  v_short := nullif(trim(coalesce(p_short_label, '')), '');
  if v_short is null then
    v_short := left(coalesce(p_label, v_slug), 16);
  end if;

  insert into public.petitions (
    slug, label, short_label, bit_index, sort_order, is_default, is_active, created_by
  )
  values (
    v_slug,
    coalesce(nullif(trim(p_label), ''), v_slug),
    v_short,
    v_bit,
    coalesce((select max(sort_order) + 10 from public.petitions), 10),
    coalesce(p_is_default, false),
    true,
    p_actor
  )
  returning * into rec;

  return to_jsonb(rec);
end;
$$;

revoke all on function public.create_petition(text, text, text, boolean, text) from public;
grant execute on function public.create_petition(text, text, text, boolean, text) to service_role;
revoke all on function public.next_petition_bit_index() from public;
grant execute on function public.next_petition_bit_index() to service_role;

-- Import: any non-blank cell counts as signed except explicit negatives.
-- PDI/Achilles often store dates or tracking codes, not just true/yes.
create or replace function public._import_is_signed(val text)
returns boolean
language sql
immutable
parallel safe
as $$
  select
    public._is_signed(val)
    or (
      nullif(trim(val), '') is not null
      and lower(trim(val)) not in (
        'false', 'f', 'no', 'n', '0', 'unsigned', 'invalid', 'none', 'null', '-'
      )
    );
$$;

revoke all on function public._import_is_signed(text) from public;
grant execute on function public._import_is_signed(text) to service_role;

create or replace function public.voter_apply_batch_signatures(
  rows jsonb,
  batch_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_applied int := 0;
begin
  if rows is null or jsonb_typeof(rows) <> 'array' then
    return jsonb_build_object('applied', 0);
  end if;

  drop table if exists _sig_incoming;
  create temporary table _sig_incoming on commit drop as
  with incoming as (
    select
      nullif(trim(r->>'murmuration_id'), '') as murmuration_id,
      nullif(trim(r->>'voter_id'), '') as voter_id,
      kv.key as slug,
      nullif(trim(kv.value #>> '{}'), '') as raw_value
    from jsonb_array_elements(rows) r
    cross join lateral jsonb_each(coalesce(r->'signatures', '{}'::jsonb)) kv
    where jsonb_typeof(coalesce(r->'signatures', 'null'::jsonb)) = 'object'
  )
  select
    v.id as voter_id,
    p.id as petition_id,
    p.slug,
    i.raw_value,
    public._import_is_signed(i.raw_value) as signed
  from incoming i
  join public.petitions p on p.slug = i.slug and p.is_active
  join public.voters v
    on (
      i.murmuration_id is not null
      and v.murmuration_id = i.murmuration_id
    )
    or (
      i.murmuration_id is null
      and i.voter_id is not null
      and v.voter_id = i.voter_id
    )
  where i.raw_value is not null;

  insert into public.voter_petition_signatures (
    voter_id, petition_id, raw_value, signed, import_batch_id, updated_at
  )
  select
    voter_id, petition_id, raw_value, signed, batch_id, now()
  from _sig_incoming
  on conflict (voter_id, petition_id) do update set
    raw_value = excluded.raw_value,
    signed = excluded.signed,
    import_batch_id = coalesce(excluded.import_batch_id, public.voter_petition_signatures.import_batch_id),
    updated_at = now();

  get diagnostics n_applied = row_count;

  -- Dual-write legacy sig_* columns (fill-in: non-null incoming wins).
  update public.voters v set
    sig_open_primaries = coalesce(s.sig_open_primaries, v.sig_open_primaries),
    sig_reproductive_freedom = coalesce(s.sig_reproductive_freedom, v.sig_reproductive_freedom),
    sig_achilles_petition = coalesce(s.sig_achilles_petition, v.sig_achilles_petition),
    sig_medical_cannabis = coalesce(s.sig_medical_cannabis, v.sig_medical_cannabis),
    sig_medical_marijuana_valid_code = coalesce(s.sig_medical_marijuana_valid_code, v.sig_medical_marijuana_valid_code)
  from (
    select
      voter_id,
      max(raw_value) filter (where slug = 'open_primaries') as sig_open_primaries,
      max(raw_value) filter (where slug = 'reproductive_freedom') as sig_reproductive_freedom,
      max(raw_value) filter (where slug = 'achilles') as sig_achilles_petition,
      max(raw_value) filter (where slug = 'medical_cannabis') as sig_medical_cannabis,
      max(raw_value) filter (where slug = 'medical_marijuana_valid') as sig_medical_marijuana_valid_code
    from _sig_incoming
    group by voter_id
  ) s
  where v.id = s.voter_id;

  return jsonb_build_object('applied', n_applied);
end;
$$;

revoke all on function public.voter_apply_batch_signatures(jsonb, uuid) from public;
grant execute on function public.voter_apply_batch_signatures(jsonb, uuid) to service_role;
