-- Per-election requested / issued / returned dates on import.
-- `rows[].absentee[slug]` may be a status string or
-- { status, requested_at, issued_at, returned_at }.

create or replace function public.voter_apply_batch_absentee(
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

  drop table if exists _abs_incoming;
  create temporary table _abs_incoming on commit drop as
  with incoming as (
    select
      nullif(trim(r->>'murmuration_id'), '') as murmuration_id,
      nullif(trim(r->>'voter_id'), '') as voter_id,
      kv.key as slug,
      case
        when jsonb_typeof(kv.value) = 'object' then nullif(trim(kv.value->>'status'), '')
        else nullif(trim(kv.value #>> '{}'), '')
      end as raw_status,
      public._parse_import_date(
        coalesce(
          case
            when jsonb_typeof(kv.value) = 'object' then kv.value->>'requested_at'
          end,
          r->>'absentee_requested_at'
        )
      ) as requested_at,
      public._parse_import_date(
        coalesce(
          case
            when jsonb_typeof(kv.value) = 'object' then kv.value->>'issued_at'
          end,
          r->>'absentee_issued_at'
        )
      ) as issued_at,
      public._parse_import_date(
        coalesce(
          case
            when jsonb_typeof(kv.value) = 'object' then kv.value->>'returned_at'
          end,
          r->>'absentee_returned_at'
        )
      ) as returned_at
    from jsonb_array_elements(rows) r
    cross join lateral jsonb_each(coalesce(r->'absentee', '{}'::jsonb)) kv
    where jsonb_typeof(coalesce(r->'absentee', 'null'::jsonb)) = 'object'
      and position(':' in kv.key) = 0
  )
  select
    v.id as voter_id,
    e.id as election_id,
    e.slug,
    i.raw_status,
    case
      when i.raw_status is not null
        and public._import_absentee_status(i.raw_status) <> 'UNKNOWN'
        then public._import_absentee_status(i.raw_status)
      when i.returned_at is not null then 'RETURNED'
      when i.issued_at is not null then 'ISSUED'
      when i.requested_at is not null then 'REQUESTED'
      else 'UNKNOWN'
    end as status,
    i.requested_at,
    i.issued_at,
    i.returned_at
  from incoming i
  join public.absentee_elections e on e.slug = i.slug and e.is_active
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
  where
    (
      i.raw_status is not null
      and public._import_absentee_status(i.raw_status) <> 'UNKNOWN'
    )
    or i.requested_at is not null
    or i.issued_at is not null
    or i.returned_at is not null;

  insert into public.voter_absentee_ballots (
    voter_id, election_id, status, raw_status,
    requested_at, issued_at, returned_at, import_batch_id, updated_at
  )
  select
    voter_id, election_id, status, raw_status,
    requested_at, issued_at, returned_at, batch_id, now()
  from _abs_incoming
  on conflict (voter_id, election_id) do update set
    status = excluded.status,
    raw_status = coalesce(excluded.raw_status, public.voter_absentee_ballots.raw_status),
    requested_at = coalesce(excluded.requested_at, public.voter_absentee_ballots.requested_at),
    issued_at = coalesce(excluded.issued_at, public.voter_absentee_ballots.issued_at),
    returned_at = coalesce(excluded.returned_at, public.voter_absentee_ballots.returned_at),
    import_batch_id = coalesce(excluded.import_batch_id, public.voter_absentee_ballots.import_batch_id),
    updated_at = now();

  get diagnostics n_applied = row_count;
  return jsonb_build_object('applied', n_applied);
end;
$$;

revoke all on function public.voter_apply_batch_absentee(jsonb, uuid) from public;
grant execute on function public.voter_apply_batch_absentee(jsonb, uuid) to service_role;
