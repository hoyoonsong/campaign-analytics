/** Server copy of poll matching / answer rules. Keep aligned with src/lib/trackingPoll. */

export type PollAnswer = 'TODD' | 'RISCH' | 'UNDECIDED' | 'OTHER' | 'UNKNOWN';
export type MatchMethod = 'profile_id' | 'phone' | 'email' | 'manual' | 'unmatched';
export type MatchStatus = 'matched' | 'unmatched' | 'conflict';

export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  return v || null;
}

export function normalizePhone10(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const ten =
    digits.length === 11 && digits.startsWith('1')
      ? digits.slice(1)
      : digits.slice(-10);
  return ten.length === 10 ? ten : null;
}

export function normalizeProfileId(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  return v || null;
}

export function personKeyFor(opts: {
  voterId?: number | null;
  profileId?: string | null;
  phone10?: string | null;
  email?: string | null;
  fallback?: string | null;
}): string {
  if (opts.voterId) return `v:${opts.voterId}`;
  if (opts.profileId) return `p:${opts.profileId}`;
  if (opts.phone10) return `ph:${opts.phone10}`;
  if (opts.email) return `e:${opts.email}`;
  return `u:${opts.fallback || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export function normalizePollAnswer(raw: string | null | undefined): PollAnswer {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return 'UNKNOWN';
  if (/\btodd\b/.test(s) || /\bachilles\b/.test(s) || s === 'ta' || s === 'achilles for idaho') {
    return 'TODD';
  }
  if (/\brisch\b/.test(s) || /\bjim risch\b/.test(s) || s === 'jr') return 'RISCH';
  if (
    /\bundecided\b/.test(s) ||
    /\bunsure\b/.test(s) ||
    /\bnot sure\b/.test(s) ||
    /\bdk\b/.test(s) ||
    s === 'und' ||
    s === "don't know" ||
    s === 'dont know'
  ) {
    return 'UNDECIDED';
  }
  if (/\bother\b/.test(s) || /\banother\b/.test(s) || /\bthird party\b/.test(s) || /\bsomeone else\b/.test(s)) {
    return 'OTHER';
  }
  return 'UNKNOWN';
}

export type VoterHit = {
  id: number;
  murmuration_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  phone10: string | null;
};

export type MatchDecision =
  | {
      status: 'matched';
      match_status: Extract<MatchStatus, 'matched'>;
      method: Exclude<MatchMethod, 'unmatched'>;
      voter: VoterHit;
      person_key: string;
    }
  | {
      status: 'unmatched';
      match_status: Extract<MatchStatus, 'unmatched'>;
      method: 'unmatched';
      voter: null;
      person_key: string;
    }
  | {
      status: 'conflict';
      match_status: Extract<MatchStatus, 'conflict'>;
      method: 'unmatched';
      voter: null;
      person_key: string;
      reason: string;
      voters: VoterHit[];
    }
  | {
      status: 'invalid';
      match_status: Extract<MatchStatus, 'unmatched'>;
      method: 'unmatched';
      voter: null;
      person_key: string;
      reason: string;
    };

function voterName(v: VoterHit): string {
  return [v.first_name, v.last_name].filter(Boolean).join(' ').trim() || `Voter ${v.id}`;
}

function uniqueById(rows: VoterHit[]): VoterHit[] {
  const seen = new Set<number>();
  const out: VoterHit[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

export function decideMatch(
  row: {
    source_profile_id?: string | null;
    source_phone?: string | null;
    source_email?: string | null;
    uid?: string | null;
  },
  byProfile: Map<string, VoterHit[]>,
  byPhone: Map<string, VoterHit[]>,
  byEmail: Map<string, VoterHit[]>,
): MatchDecision {
  const profileId = normalizeProfileId(row.source_profile_id);
  const phone10 = normalizePhone10(row.source_phone);
  const email = normalizeEmail(row.source_email);
  const fallbackKey = personKeyFor({
    profileId,
    phone10,
    email,
    fallback: row.uid ?? null,
  });

  if (!profileId && !phone10 && !email) {
    return {
      status: 'invalid',
      match_status: 'unmatched',
      method: 'unmatched',
      voter: null,
      person_key: fallbackKey,
      reason: 'Unmatched / Insufficient Identifier',
    };
  }

  const profileHits = uniqueById(profileId ? byProfile.get(profileId) ?? [] : []);
  const phoneHits = uniqueById(phone10 ? byPhone.get(phone10) ?? [] : []);
  const emailHits = uniqueById(email ? byEmail.get(email) ?? [] : []);

  if (profileHits.length > 1) {
    return {
      status: 'conflict',
      match_status: 'conflict',
      method: 'unmatched',
      voter: null,
      person_key: fallbackKey,
      reason: 'Identifier Conflict — Manual Review Required (multiple profile ID matches)',
      voters: profileHits,
    };
  }

  if (profileHits.length === 1) {
    const voter = profileHits[0];
    const phoneOther = phoneHits.filter((v) => v.id !== voter.id);
    const emailOther = emailHits.filter((v) => v.id !== voter.id);
    if (phoneOther.length || emailOther.length) {
      return {
        status: 'conflict',
        match_status: 'conflict',
        method: 'unmatched',
        voter: null,
        person_key: fallbackKey,
        reason: `Identifier Conflict — Manual Review Required (profile ${voterName(voter)} vs ${[...phoneOther, ...emailOther].map(voterName).join(', ')})`,
        voters: uniqueById([voter, ...phoneOther, ...emailOther]),
      };
    }
    return {
      status: 'matched',
      match_status: 'matched',
      method: 'profile_id',
      voter,
      person_key: personKeyFor({ voterId: voter.id }),
    };
  }

  if (phoneHits.length > 1) {
    return {
      status: 'conflict',
      match_status: 'conflict',
      method: 'unmatched',
      voter: null,
      person_key: fallbackKey,
      reason: 'Identifier Conflict — Manual Review Required (phone matches multiple profiles)',
      voters: phoneHits,
    };
  }

  if (phoneHits.length === 1) {
    const voter = phoneHits[0];
    const emailOther = emailHits.filter((v) => v.id !== voter.id);
    if (emailOther.length) {
      return {
        status: 'conflict',
        match_status: 'conflict',
        method: 'unmatched',
        voter: null,
        person_key: fallbackKey,
        reason: `Identifier Conflict — Manual Review Required (phone → ${voterName(voter)}, email → ${emailOther.map(voterName).join(', ')})`,
        voters: uniqueById([voter, ...emailOther]),
      };
    }
    return {
      status: 'matched',
      match_status: 'matched',
      method: 'phone',
      voter,
      person_key: personKeyFor({ voterId: voter.id }),
    };
  }

  if (emailHits.length > 1) {
    return {
      status: 'conflict',
      match_status: 'conflict',
      method: 'unmatched',
      voter: null,
      person_key: fallbackKey,
      reason: 'Identifier Conflict — Manual Review Required (email matches multiple profiles)',
      voters: emailHits,
    };
  }

  if (emailHits.length === 1) {
    return {
      status: 'matched',
      match_status: 'matched',
      method: 'email',
      voter: emailHits[0],
      person_key: personKeyFor({ voterId: emailHits[0].id }),
    };
  }

  return {
    status: 'unmatched',
    match_status: 'unmatched',
    method: 'unmatched',
    voter: null,
    person_key: fallbackKey,
  };
}

export function indexVoters(voters: VoterHit[]): {
  byProfile: Map<string, VoterHit[]>;
  byPhone: Map<string, VoterHit[]>;
  byEmail: Map<string, VoterHit[]>;
} {
  const byProfile = new Map<string, VoterHit[]>();
  const byPhone = new Map<string, VoterHit[]>();
  const byEmail = new Map<string, VoterHit[]>();
  const push = (map: Map<string, VoterHit[]>, key: string | null, v: VoterHit) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    list.push(v);
    map.set(key, list);
  };
  for (const v of voters) {
    push(byProfile, normalizeProfileId(v.murmuration_id), v);
    push(byPhone, v.phone10 || normalizePhone10(v.phone), v);
    push(byEmail, normalizeEmail(v.email), v);
  }
  return { byProfile, byPhone, byEmail };
}
