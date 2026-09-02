import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  isCloudflareOriginDeath,
  isExpensiveVoterRequest,
  isVoterOriginDown,
  isVoterOriginTimeout,
  markVoterOriginDown,
  markVoterOriginUp,
  VOTER_ORIGIN_TIMEOUT_MESSAGE,
} from './originError.js';

export interface AuthedContext {
  user: User;
  profile: { id: string; role: string; email: string | null; full_name: string | null };
  voter: SupabaseClient;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export function cors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'authorization, content-type, x-client-info, apikey',
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
}

export function json(res: VercelResponse, status: number, body: unknown) {
  if (
    body &&
    typeof body === 'object' &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'string'
  ) {
    const raw = (body as { error: string }).error;
    if (isVoterOriginTimeout(raw)) {
      res.status(status).json({
        ...(body as object),
        error: VOTER_ORIGIN_TIMEOUT_MESSAGE,
      });
      return;
    }
  }
  res.status(status).json(body);
}

/** Cheap table reads get 20s. Heavy RPCs get 10s and a circuit breaker. */
const voterFetch: typeof fetch = async (input, init) => {
  const expensive = isExpensiveVoterRequest(input);
  if (expensive && isVoterOriginDown()) {
    throw new Error(VOTER_ORIGIN_TIMEOUT_MESSAGE);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), expensive ? 10_000 : 20_000);
  try {
    const res = await fetch(input, { ...init, signal: ctrl.signal });
    if (res.ok) {
      markVoterOriginUp();
      return res;
    }
    const preview = await res
      .clone()
      .text()
      .then((t) => t.slice(0, 400))
      .catch(() => '');
    if (isCloudflareOriginDeath(preview, res.status)) {
      markVoterOriginDown();
      throw new Error(VOTER_ORIGIN_TIMEOUT_MESSAGE);
    }
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (isCloudflareOriginDeath(msg)) {
      markVoterOriginDown();
      throw new Error(VOTER_ORIGIN_TIMEOUT_MESSAGE);
    }
    if (/aborted/i.test(msg)) {
      if (expensive) markVoterOriginDown();
      throw new Error(VOTER_ORIGIN_TIMEOUT_MESSAGE);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

export async function requireCampaignUser(
  req: VercelRequest,
  res: VercelResponse,
): Promise<AuthedContext | null> {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return null;
  }

  try {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) {
      json(res, 401, { error: 'Unauthorized' });
      return null;
    }
    const token = auth.slice('Bearer '.length).trim();
    if (!token) {
      json(res, 401, { error: 'Unauthorized' });
      return null;
    }

    const campaignUrl = env('CAMPAIGN_SUPABASE_URL');
    const campaignAnon = env('CAMPAIGN_SUPABASE_ANON_KEY');
    const voterUrl = env('VOTER_SUPABASE_URL');
    const voterService = env('VOTER_SUPABASE_SERVICE_ROLE_KEY');

    const campaign = createClient(campaignUrl, campaignAnon, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: userData, error: userErr } = await campaign.auth.getUser(token);
    if (userErr || !userData.user) {
      json(res, 401, { error: 'Unauthorized' });
      return null;
    }

    const campaignAdminKey = process.env.CAMPAIGN_SUPABASE_SERVICE_ROLE_KEY;
    const profileClient = campaignAdminKey
      ? createClient(campaignUrl, campaignAdminKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : campaign;

    const { data: profile, error: profileErr } = await profileClient
      .from('profiles')
      .select('id, role, email, full_name')
      .eq('id', userData.user.id)
      .maybeSingle();

    if (profileErr || !profile) {
      json(res, 403, { error: 'No team profile' });
      return null;
    }

    const voter = createClient(voterUrl, voterService, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: voterFetch },
    });

    return {
      user: userData.user,
      profile: profile as AuthedContext['profile'],
      voter,
    };
  } catch (err) {
    json(res, 500, {
      error: err instanceof Error ? err.message : 'Server error',
    });
    return null;
  }
}

export function readBody<T>(req: VercelRequest): T {
  return (req.body ?? {}) as T;
}
