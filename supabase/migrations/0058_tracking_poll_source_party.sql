-- Keep poll-file party/gender on the response so charts match the tracking
-- spreadsheet even when a row does not match a voter (or identifiers conflict).

alter table public.tracking_poll_responses
  add column if not exists source_party text,
  add column if not exists source_gender text;

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
          coalesce(nullif(trim(t.source_party), ''), v.party) as party,
          coalesce(nullif(trim(t.source_gender), ''), v.contact_tags) as gender
        from public.tracking_poll_responses t
        join public.tracking_polls tp on tp.id = t.poll_id
        left join public.voters v on v.id = t.voter_id
        order by t.id
      ) r
    ), '[]'::json)
  );
$$;
