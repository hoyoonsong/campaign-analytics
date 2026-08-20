export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  return v || null;
}

/** Final 10 U.S. digits. Strips formatting and a leading +1. */
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
  return `u:${opts.fallback || cryptoRandom()}`;
}

export function isStablePersonKey(key: string): boolean {
  return key.startsWith('v:') || key.startsWith('p:') || key.startsWith('ph:') || key.startsWith('e:');
}

function cryptoRandom(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
