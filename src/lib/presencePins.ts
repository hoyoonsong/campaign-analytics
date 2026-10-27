/** Campaign FormHandler presence pins as stored in lean geo. */
export type RawPresencePin = {
  kind: 'volunteer' | 'yard_sign';
  lat: number;
  lng: number;
  source_id?: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  is_big?: boolean;
};

/** Map display kinds — one marker per person. */
export type PresenceKind = 'volunteer' | 'yard_sign' | 'both';

export type PresencePin = {
  kind: PresenceKind;
  lat: number;
  lng: number;
  source_id?: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  /** How many FormHandler yard-sign rows this person has (1+). */
  yard_sign_count?: number;
  /** True when at least one of those yard signs is marked big. */
  is_big?: boolean;
};

function personKey(p: RawPresencePin): string {
  const email = p.email?.trim().toLowerCase();
  if (email) return `e:${email}`;
  const phone = (p.phone ?? '').replace(/\D/g, '');
  if (phone.length >= 7) return `p:${phone}`;
  const name = p.name?.trim().toLowerCase();
  if (name) {
    return `n:${name}:${p.lat.toFixed(3)}:${p.lng.toFixed(3)}`;
  }
  return `id:${p.kind}:${p.source_id ?? `${p.lat},${p.lng}`}`;
}

/**
 * Collapse FormHandler rows to one map pin per person:
 * - volunteer + any yard signs → single "both" pin (at volunteer coords)
 * - multiple yard signs only → one yard-sign pin
 * - volunteer only → one volunteer pin
 */
export function collapsePresencePins(raw: RawPresencePin[]): PresencePin[] {
  const groups = new Map<string, RawPresencePin[]>();
  for (const p of raw) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const key = personKey(p);
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }

  const out: PresencePin[] = [];
  for (const pins of groups.values()) {
    const vols = pins.filter((p) => p.kind === 'volunteer');
    const yards = pins.filter((p) => p.kind === 'yard_sign');
    const ysPrimary =
      yards.find((y) => (y.address ?? '').trim()) ?? yards[0] ?? null;
    const vol = vols[0] ?? null;

    if (vol && ysPrimary) {
      out.push({
        kind: 'both',
        lat: vol.lat,
        lng: vol.lng,
        source_id: vol.source_id ?? ysPrimary.source_id,
        name: vol.name || ysPrimary.name,
        email: vol.email || ysPrimary.email,
        phone: vol.phone || ysPrimary.phone,
        address: ysPrimary.address || vol.address,
        yard_sign_count: yards.length,
        is_big: yards.some((yard) => yard.is_big),
      });
      continue;
    }

    if (ysPrimary) {
      out.push({
        kind: 'yard_sign',
        lat: ysPrimary.lat,
        lng: ysPrimary.lng,
        source_id: ysPrimary.source_id,
        name: ysPrimary.name,
        email: ysPrimary.email,
        phone: ysPrimary.phone,
        address: ysPrimary.address,
        yard_sign_count: yards.length,
        is_big: yards.some((yard) => yard.is_big),
      });
      continue;
    }

    if (vol) {
      out.push({
        kind: 'volunteer',
        lat: vol.lat,
        lng: vol.lng,
        source_id: vol.source_id,
        name: vol.name,
        email: vol.email,
        phone: vol.phone,
        address: vol.address,
      });
    }
  }
  return out;
}
