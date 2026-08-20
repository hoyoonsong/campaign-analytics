-- One-shot slim payload for the tracking page (polls + answers + party/gender).
-- Avoids paging every response and then looking up voters in batches.

create or replace function public.tracking_poll_dashboard()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'polls', coalesce((
      select json_agg(p)
      from (
        select id, poll_date, label, created_at
        from public.tracking_polls
        order by poll_date
      ) p
    ), '[]'::json),
    'responses', coalesce((
      select json_agg(r)
      from (
        select
          t.id,
          t.poll_id,
          tp.poll_date,
          t.person_key,
          t.normalized_answer,
          t.voter_id,
          v.party,
          v.contact_tags as gender
        from public.tracking_poll_responses t
        join public.tracking_polls tp on tp.id = t.poll_id
        left join public.voters v on v.id = t.voter_id
        order by t.id
      ) r
    ), '[]'::json)
  );
$$;

revoke all on function public.tracking_poll_dashboard() from public;
grant execute on function public.tracking_poll_dashboard() to service_role;
