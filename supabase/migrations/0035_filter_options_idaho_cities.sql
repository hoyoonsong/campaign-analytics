-- Cities (and counties) for filters: distinct values from Idaho voters in the DB.
-- Fixes incomplete static city lists (e.g. missing Preston).

create or replace function public.voter_filter_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform set_config('statement_timeout', '60s', true);
  return jsonb_build_object(
    'counties', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(county)) county as x
      from public.voters
      where nullif(trim(county), '') is not null
        and lower(trim(coalesce(state, ''))) in ('id', 'idaho')
      order by lower(county), county
      limit 200
    ) s), '[]'::jsonb),
    'parties', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(party)) party as x
      from public.voters
      where nullif(trim(party), '') is not null
      order by lower(party), party
      limit 100
    ) s), '[]'::jsonb),
    'statuses', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(status)) status as x
      from public.voters
      where nullif(trim(status), '') is not null
      order by lower(status), status
      limit 50
    ) s), '[]'::jsonb),
    'states', coalesce((select jsonb_agg(x order by x) from (
      select distinct upper(trim(state)) as x
      from public.voters
      where nullif(trim(state), '') is not null
      limit 60
    ) s), '[]'::jsonb),
    'cities', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(city)) city as x
      from public.voters
      where nullif(trim(city), '') is not null
        and lower(trim(coalesce(state, ''))) in ('id', 'idaho')
      order by lower(city), city
      limit 2000
    ) s), '[]'::jsonb),
    'alignment_labels', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(alignment_label)) alignment_label as x
      from public.voters
      where nullif(trim(alignment_label), '') is not null
      order by lower(alignment_label), alignment_label
      limit 50
    ) s), '[]'::jsonb),
    'yard_signs', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(yard_sign)) yard_sign as x
      from public.voters
      where nullif(trim(yard_sign), '') is not null
      order by lower(yard_sign), yard_sign
      limit 50
    ) s), '[]'::jsonb),
    'volunteer_interests', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(volunteer_interest)) volunteer_interest as x
      from public.voters
      where nullif(trim(volunteer_interest), '') is not null
      order by lower(volunteer_interest), volunteer_interest
      limit 50
    ) s), '[]'::jsonb),
    'newsletters', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(newsletter)) newsletter as x
      from public.voters
      where nullif(trim(newsletter), '') is not null
      order by lower(newsletter), newsletter
      limit 50
    ) s), '[]'::jsonb),
    'donated', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(donated)) donated as x
      from public.voters
      where nullif(trim(donated), '') is not null
      order by lower(donated), donated
      limit 50
    ) s), '[]'::jsonb),
    'attended_events', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(attended_event)) attended_event as x
      from public.voters
      where nullif(trim(attended_event), '') is not null
      order by lower(attended_event), attended_event
      limit 50
    ) s), '[]'::jsonb),
    'top_main_topics', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(top_main_topic)) top_main_topic as x
      from public.voters
      where nullif(trim(top_main_topic), '') is not null
      order by lower(top_main_topic), top_main_topic
      limit 100
    ) s), '[]'::jsonb),
    'convos_candidate_support', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(convos_candidate_support)) convos_candidate_support as x
      from public.voters
      where nullif(trim(convos_candidate_support), '') is not null
      order by lower(convos_candidate_support), convos_candidate_support
      limit 50
    ) s), '[]'::jsonb),
    'convos_contact_status', coalesce((select jsonb_agg(x order by x) from (
      select distinct on (lower(convos_contact_status)) convos_contact_status as x
      from public.voters
      where nullif(trim(convos_contact_status), '') is not null
      order by lower(convos_contact_status), convos_contact_status
      limit 50
    ) s), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.voter_filter_options() from public;
grant execute on function public.voter_filter_options() to service_role;

-- Bust cached filter options so Preston etc. show up immediately.
update public.campaign_sync_state
set
  filter_options_cache = null,
  filter_options_cached_at = null,
  updated_at = now()
where id = 1;
