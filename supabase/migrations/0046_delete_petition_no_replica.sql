-- Fix delete_petition: service_role cannot set session_replication_role.
-- Skip the per-row signed_mask trigger via a transaction-local GUC, then
-- clear the bit in one voters UPDATE.

create or replace function public._sync_voter_signed_mask()
returns trigger
language plpgsql
as $$
declare
  v_id bigint;
  v_bit smallint;
  v_signed boolean;
begin
  if current_setting('petitions.skip_mask_sync', true) = 'on' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    v_id := old.voter_id;
    select bit_index into v_bit from public.petitions where id = old.petition_id;
    if v_bit is not null then
      update public.voters
      set signed_mask = signed_mask & ~ (1::bigint << v_bit)
      where id = v_id;
    end if;
    return old;
  end if;

  v_id := new.voter_id;
  v_signed := new.signed;
  select bit_index into v_bit from public.petitions where id = new.petition_id;
  if v_bit is null then
    return new;
  end if;
  if v_signed then
    update public.voters
    set signed_mask = signed_mask | (1::bigint << v_bit)
    where id = v_id;
  else
    update public.voters
    set signed_mask = signed_mask & ~ (1::bigint << v_bit)
    where id = v_id;
  end if;
  return new;
end;
$$;

create or replace function public.delete_petition(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.petitions;
  v_bit smallint;
begin
  select * into rec from public.petitions where id = p_id;
  if not found then
    return jsonb_build_object('error', 'Petition not found');
  end if;
  v_bit := rec.bit_index;

  perform set_config('petitions.skip_mask_sync', 'on', true);

  delete from public.voter_petition_signatures where petition_id = p_id;
  delete from public.petitions where id = p_id;

  if v_bit is not null then
    update public.voters
    set signed_mask = signed_mask & ~ (1::bigint << v_bit)
    where (coalesce(signed_mask, 0) & (1::bigint << v_bit)) <> 0;
  end if;

  update public.campaign_sync_state
  set analytics_summary_cache = null,
      analytics_summary_cached_at = null
  where id = 1;

  return to_jsonb(rec);
end;
$$;

revoke all on function public.delete_petition(bigint) from public;
grant execute on function public.delete_petition(bigint) to service_role;
