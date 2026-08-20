/** Import de-duplication (same rules as CampaignFormHandler). */

export interface Pii {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  murmuration_id?: string | null;
  voter_id?: string | null;
}

export function normEmail(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

export function normPhone(s: string | null | undefined): string {
  const d = (s ?? '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

export function normName(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normAddress(s: string | null | undefined): string {
  return (s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Collapse duplicates within a single import file.
 * Prefer rows that already have a voter_id; later rows fill blanks into the kept row.
 */
export class DedupeIndex {
  private byMurmurationId = new Map<string, number>();
  private byVoterId = new Map<string, number>();
  private byEmail = new Map<string, number>();
  private byPhone = new Map<string, number>();
  private byNameAddr = new Map<string, number>();
  private hasStrongId: boolean[] = [];

  find(r: Pii): number | null {
    const mid = (r.murmuration_id ?? '').trim();
    if (mid && this.byMurmurationId.has(mid)) return this.byMurmurationId.get(mid)!;
    const vid = (r.voter_id ?? '').trim();
    if (vid && this.byVoterId.has(vid)) return this.byVoterId.get(vid)!;

    const allow = (idx: number) => {
      const incomingStrong = Boolean(mid || vid);
      const existingStrong = this.hasStrongId[idx] === true;
      // Two identified people (different IDs) are not the same household match.
      if (incomingStrong && existingStrong) return false;
      return true;
    };

    const email = normEmail(r.email);
    if (email && this.byEmail.has(email)) {
      const idx = this.byEmail.get(email)!;
      if (allow(idx)) return idx;
    }
    const phone = normPhone(r.phone);
    if (phone.length >= 7 && this.byPhone.has(phone)) {
      const idx = this.byPhone.get(phone)!;
      if (allow(idx)) return idx;
    }
    const name = normName(r.name);
    const addr = normAddress(r.address);
    if (name && addr) {
      const k = `${name}|${addr}`;
      if (this.byNameAddr.has(k)) {
        const idx = this.byNameAddr.get(k)!;
        if (allow(idx)) return idx;
      }
    }
    return null;
  }

  add(index: number, r: Pii): void {
    const mid = (r.murmuration_id ?? '').trim();
    const vid = (r.voter_id ?? '').trim();
    const email = normEmail(r.email);
    const phone = normPhone(r.phone);
    const name = normName(r.name);
    const addr = normAddress(r.address);
    this.hasStrongId[index] = Boolean(mid || vid);
    if (mid && !this.byMurmurationId.has(mid)) this.byMurmurationId.set(mid, index);
    if (vid && !this.byVoterId.has(vid)) this.byVoterId.set(vid, index);
    if (email && !this.byEmail.has(email)) this.byEmail.set(email, index);
    if (phone.length >= 7 && !this.byPhone.has(phone)) this.byPhone.set(phone, index);
    if (name && addr) {
      const k = `${name}|${addr}`;
      if (!this.byNameAddr.has(k)) this.byNameAddr.set(k, index);
    }
  }
}

function isEmpty(v: unknown): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

/** Merge incoming into kept: fill blanks; overwrite non-empty campaign fields. */
export function mergeImportRows(
  kept: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...kept };
  const overwrite = new Set([
    'party',
    'status',
    'lat',
    'lng',
    'age',
    'support_score',
    'volunteer_interest',
    'yard_sign',
    'newsletter',
    'donated',
    'attended_event',
    'contact_tags',
    'alignment_label',
    'alignment_score',
    'top_main_topic',
    'convos_candidate_support',
    'convos_contact_status',
    'convos_poll_question',
    'sig_open_primaries',
    'sig_reproductive_freedom',
    'sig_achilles_petition',
    'sig_medical_cannabis',
    'sig_medical_marijuana_valid_code',
    'sig_reproductive_freedom_valid_code',
    'signatures',
  ]);

  for (const [k, v] of Object.entries(incoming)) {
    if (isEmpty(v)) continue;
    if (
      k === 'signatures' &&
      v &&
      typeof v === 'object' &&
      out.signatures &&
      typeof out.signatures === 'object'
    ) {
      out.signatures = {
        ...(out.signatures as Record<string, unknown>),
        ...(v as Record<string, unknown>),
      };
      continue;
    }
    if (isEmpty(out[k]) || overwrite.has(k)) out[k] = v;
  }
  return out;
}

/** Collapse in-file duplicates before sending batches to the API. */
export function collapseImportRows(
  rows: Record<string, unknown>[],
): { rows: Record<string, unknown>[]; collapsed: number } {
  const index = new DedupeIndex();
  const kept: Record<string, unknown>[] = [];
  let collapsed = 0;

  for (const row of rows) {
    const pii: Pii = {
      murmuration_id: row.murmuration_id as string | null,
      voter_id: row.voter_id as string | null,
      email: row.email as string | null,
      phone: row.phone as string | null,
      name: [row.first_name, row.last_name].filter(Boolean).join(' '),
      address: row.address_line_1 as string | null,
    };
    const hit = index.find(pii);
    if (hit == null) {
      index.add(kept.length, pii);
      kept.push(row);
    } else {
      kept[hit] = mergeImportRows(kept[hit], row);
      collapsed += 1;
    }
  }

  return { rows: kept, collapsed };
}
