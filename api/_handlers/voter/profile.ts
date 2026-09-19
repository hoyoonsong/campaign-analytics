import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';
import {
  campaignAdminClient,
  fetchCampaignPersonDetail,
  normalizeEmail,
} from '../../_lib/campaign.js';
import {
  enrichSearchRows,
  loadLeanGeo,
  nearestMiles,
} from '../../_lib/enrichSearch.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const idRaw =
    req.method === 'GET'
      ? req.query.id
      : readBody<{ id?: number | string }>(req).id;
  const id = typeof idRaw === 'string' ? Number(idRaw) : Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) {
    return json(res, 400, { error: 'id is required' });
  }

  const { data, error } = await ctx.voter.rpc('voter_get_profile', { p_id: id });
  if (error) return json(res, 500, { error: error.message });
  if (!data) return json(res, 404, { error: 'Not found' });

  let voter = data as Record<string, unknown> & {
    id: number;
    email?: string | null;
    phone?: string | null;
    campaign_person_id?: string | null;
    lat?: number | null;
    lng?: number | null;
    supporter_tag?: string | null;
  };

  // Same tag + distance rules as Search.
  try {
    const [enriched] = await enrichSearchRows(ctx.voter, [voter], {
      geocode: true,
    });
    voter = { ...voter, ...enriched };
  } catch {
    /* best-effort */
  }

  let campaign: Awaited<ReturnType<typeof fetchCampaignPersonDetail>> | null =
    null;
  let nearby: {
    yard_sign_miles: number | null;
    volunteer_miles: number | null;
  } | null = null;

  try {
    const campaignClient = campaignAdminClient();
    let personId =
      typeof voter.campaign_person_id === 'string'
        ? voter.campaign_person_id
        : null;

    if (!personId) {
      const email = normalizeEmail(voter.email);
      if (email) {
        const { data: byEmail } = await campaignClient
          .from('people')
          .select('id')
          .eq('email', email)
          .maybeSingle();
        personId = byEmail?.id ?? null;
      }
    }

    if (personId) {
      campaign = await fetchCampaignPersonDetail(campaignClient, personId);
    }
  } catch {
    campaign = null;
  }

  const yardFromEnrich =
    typeof voter.nearby_yard_sign_miles === 'number'
      ? voter.nearby_yard_sign_miles
      : null;
  const volFromEnrich =
    typeof voter.nearby_volunteer_miles === 'number'
      ? voter.nearby_volunteer_miles
      : null;

  if (yardFromEnrich != null || volFromEnrich != null) {
    nearby = {
      yard_sign_miles: yardFromEnrich,
      volunteer_miles: volFromEnrich,
    };
  } else if (voter.lat != null && voter.lng != null) {
    const geo = await loadLeanGeo(ctx.voter);
    nearby = {
      yard_sign_miles: nearestMiles(
        Number(voter.lat),
        Number(voter.lng),
        geo,
        'yard_sign',
        null,
      ),
      volunteer_miles: nearestMiles(
        Number(voter.lat),
        Number(voter.lng),
        geo,
        'volunteer',
        null,
      ),
    };
  }

  try {
    const { data: sigRows } = await ctx.voter
      .from('voter_petition_signatures')
      .select('raw_value, signed, petitions(slug, label, sort_order)')
      .eq('voter_id', id)
      .eq('signed', true);
    if (Array.isArray(sigRows)) {
      voter.petition_signatures = sigRows
        .map((row) => {
          const p = (row as { petitions?: { slug?: string; label?: string; sort_order?: number } | { slug?: string; label?: string; sort_order?: number }[] }).petitions;
          const pet = Array.isArray(p) ? p[0] : p;
          return {
            slug: pet?.slug ?? '',
            label: pet?.label ?? pet?.slug ?? 'Petition',
            sort_order: pet?.sort_order ?? 0,
            raw_value: (row as { raw_value?: string | null }).raw_value ?? null,
          };
        })
        .filter((s) => s.slug)
        .sort((a, b) => a.sort_order - b.sort_order);
    }
  } catch {
    /* registry may not be applied yet */
  }

  try {
    const { data: ballotRows } = await ctx.voter
      .from('voter_absentee_ballots')
      .select(
        'status, raw_status, requested_at, issued_at, returned_at, absentee_elections(slug, label, sort_order)',
      )
      .eq('voter_id', id);
    if (Array.isArray(ballotRows)) {
      voter.absentee_ballots = ballotRows
        .map((row) => {
          const e = (
            row as {
              absentee_elections?:
                | { slug?: string; label?: string; sort_order?: number }
                | { slug?: string; label?: string; sort_order?: number }[];
            }
          ).absentee_elections;
          const el = Array.isArray(e) ? e[0] : e;
          return {
            slug: el?.slug ?? '',
            label: el?.label ?? el?.slug ?? 'Absentee',
            sort_order: el?.sort_order ?? 0,
            status: (row as { status?: string }).status ?? 'UNKNOWN',
            raw_status: (row as { raw_status?: string | null }).raw_status ?? null,
            requested_at: (row as { requested_at?: string | null }).requested_at ?? null,
            issued_at: (row as { issued_at?: string | null }).issued_at ?? null,
            returned_at: (row as { returned_at?: string | null }).returned_at ?? null,
          };
        })
        .filter((s) => s.slug)
        .sort((a, b) => a.sort_order - b.sort_order);
    }
  } catch {
    /* absentee tables may not be applied yet */
  }

  return json(res, 200, { voter, campaign, nearby });
}
