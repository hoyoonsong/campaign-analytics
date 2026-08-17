import type {
  ExcludeAttrKey,
  ExcludeRules,
  FilterAnyOfRule,
  SignedPetitionKey,
  VoterFilters,
} from './types';
import { petitionLabel } from './petitions';
import { summarizeAnyOfRule } from './supporterPresets';

/** Sentinel for null/empty residence state in include & exclude filters. */
export const STATE_BLANK = '__blank__';

export function formatStateFilterValue(v: string): string {
  return v === STATE_BLANK ? '(Blank)' : v;
}

export function emptyFilters(): VoterFilters {
  return {
    county: [],
    party: [],
    city: [],
    zip: [],
    status: [],
    state: [],
    age_min: null,
    age_max: null,
    support_score_min: null,
    support_score_max: null,
    signed: [],
    signed_any: null,
    signed_all_core: null,
    signed_min: null,
    signed_min_of: [],
    alignment_label: [],
    yard_sign: [],
    volunteer_interest: [],
    newsletter: [],
    donated: [],
    attended_event: [],
    top_main_topic: [],
    convos_candidate_support: [],
    convos_contact_status: [],
    has_volunteer: null,
    has_yard_sign: null,
    has_donated: null,
    nearby_yard_sign_miles: null,
    nearby_volunteer_miles: null,
    nearby_yard_sign_min_miles: null,
    nearby_yard_sign_max_miles: null,
    nearby_volunteer_min_miles: null,
    nearby_volunteer_max_miles: null,
    supporter_tag: [],
    any_of: [],
    possible_duplicates: null,
    exclude: {},
  };
}

/** Omit empty arrays / null flags so SQL treats them as "no filter". */
export function toFilterPayload(f: VoterFilters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, values?: string[] | SignedPetitionKey[]) => {
    if (values?.length) out[key] = values;
  };

  put('county', f.county);
  put('party', f.party);
  put('city', f.city);
  put('zip', f.zip);
  put('status', f.status);
  put('state', f.state);
  if (f.age_min != null) out.age_min = f.age_min;
  if (f.age_max != null) out.age_max = f.age_max;
  if (f.support_score_min != null) out.support_score_min = f.support_score_min;
  if (f.support_score_max != null) out.support_score_max = f.support_score_max;
  put('signed', f.signed);
  if (f.signed_any === true) out.signed_any = true;
  if (f.signed_all_core === true) out.signed_all_core = true;
  if (f.signed_min != null && f.signed_min > 0) out.signed_min = f.signed_min;
  put('signed_min_of', f.signed_min_of);
  put('alignment_label', f.alignment_label);
  put('yard_sign', f.yard_sign);
  put('volunteer_interest', f.volunteer_interest);
  put('newsletter', f.newsletter);
  put('donated', f.donated);
  put('attended_event', f.attended_event);
  put('top_main_topic', f.top_main_topic);
  put('convos_candidate_support', f.convos_candidate_support);
  put('convos_contact_status', f.convos_contact_status);
  if (f.has_volunteer === true) out.has_volunteer = true;
  if (f.has_yard_sign === true) out.has_yard_sign = true;
  if (f.has_donated === true) out.has_donated = true;

  const yardMin = f.nearby_yard_sign_min_miles;
  const yardMax =
    f.nearby_yard_sign_max_miles ?? f.nearby_yard_sign_miles ?? null;
  const volMin = f.nearby_volunteer_min_miles;
  const volMax =
    f.nearby_volunteer_max_miles ?? f.nearby_volunteer_miles ?? null;
  if (yardMin != null && yardMin > 0) out.nearby_yard_sign_min_miles = yardMin;
  if (yardMax != null && yardMax > 0) out.nearby_yard_sign_max_miles = yardMax;
  if (volMin != null && volMin > 0) out.nearby_volunteer_min_miles = volMin;
  if (volMax != null && volMax > 0) out.nearby_volunteer_max_miles = volMax;

  // Indexed DB column (materialized by recompute_supporter_tags).
  put('supporter_tag', f.supporter_tag);
  if (f.possible_duplicates === true) out.possible_duplicates = true;

  if (f.any_of?.length) {
    out.any_of = f.any_of.filter((r) => r.values?.length);
  }

  const ex = f.exclude ?? {};
  put('exclude_county', ex.county);
  put('exclude_party', ex.party);
  put('exclude_city', ex.city);
  put('exclude_zip', ex.zip);
  put('exclude_state', ex.state);
  put('exclude_status', ex.status);
  put('exclude_signed', ex.signed);
  put('exclude_supporter_tag', ex.supporter_tag);
  put('exclude_alignment_label', ex.alignment_label);
  put('exclude_yard_sign', ex.yard_sign);
  put('exclude_volunteer_interest', ex.volunteer_interest);
  put('exclude_newsletter', ex.newsletter);
  put('exclude_donated', ex.donated);
  put('exclude_attended_event', ex.attended_event);
  put('exclude_top_main_topic', ex.top_main_topic);
  put('exclude_convos_candidate_support', ex.convos_candidate_support);
  put('exclude_convos_contact_status', ex.convos_contact_status);
  if (ex.age_min != null) out.exclude_age_min = ex.age_min;
  if (ex.age_max != null) out.exclude_age_max = ex.age_max;
  if (ex.support_score_min != null) {
    out.exclude_support_score_min = ex.support_score_min;
  }
  if (ex.support_score_max != null) {
    out.exclude_support_score_max = ex.support_score_max;
  }
  if (ex.has_volunteer === true) out.exclude_has_volunteer = true;
  if (ex.has_yard_sign === true) out.exclude_has_yard_sign = true;
  if (ex.has_donated === true) out.exclude_has_donated = true;
  if (ex.campaign_volunteer === true) out.exclude_campaign_volunteer = true;

  return out;
}

export function filtersActive(f: VoterFilters): boolean {
  return Object.keys(toFilterPayload(f)).length > 0;
}

const ARRAY_EXCLUDE_KEYS: ExcludeAttrKey[] = [
  'signed',
  'supporter_tag',
  'alignment_label',
  'yard_sign',
  'volunteer_interest',
  'newsletter',
  'donated',
  'attended_event',
  'top_main_topic',
  'convos_candidate_support',
  'convos_contact_status',
  'county',
  'party',
  'city',
  'zip',
  'state',
  'status',
];

export function setExcludeValues(
  filters: VoterFilters,
  attr: ExcludeAttrKey,
  values: string[],
): VoterFilters {
  const exclude: ExcludeRules = { ...(filters.exclude ?? {}) };

  if (
    attr === 'has_volunteer' ||
    attr === 'has_yard_sign' ||
    attr === 'has_donated' ||
    attr === 'campaign_volunteer'
  ) {
    if (!values.length) delete exclude[attr];
    else exclude[attr] = true;
    return { ...filters, exclude };
  }

  if (attr === 'age' || attr === 'support_score') {
    return filters;
  }

  if (!ARRAY_EXCLUDE_KEYS.includes(attr)) return filters;

  if (!values.length) {
    delete exclude[attr as keyof ExcludeRules];
  } else if (attr === 'signed') {
    exclude.signed = values as SignedPetitionKey[];
  } else {
    (exclude as Record<string, string[]>)[attr] = values;
  }
  return { ...filters, exclude };
}

export function setExcludeRange(
  filters: VoterFilters,
  kind: 'age' | 'support_score',
  min: number | null,
  max: number | null,
): VoterFilters {
  const exclude: ExcludeRules = { ...(filters.exclude ?? {}) };
  if (kind === 'age') {
    exclude.age_min = min;
    exclude.age_max = max;
    if (min == null && max == null) {
      delete exclude.age_min;
      delete exclude.age_max;
    }
  } else {
    exclude.support_score_min = min;
    exclude.support_score_max = max;
    if (min == null && max == null) {
      delete exclude.support_score_min;
      delete exclude.support_score_max;
    }
  }
  return { ...filters, exclude };
}

export function clearExcludeAttr(
  filters: VoterFilters,
  attr: ExcludeAttrKey,
): VoterFilters {
  const exclude: ExcludeRules = { ...(filters.exclude ?? {}) };
  if (attr === 'age') {
    delete exclude.age_min;
    delete exclude.age_max;
  } else if (attr === 'support_score') {
    delete exclude.support_score_min;
    delete exclude.support_score_max;
  } else {
    delete exclude[attr as keyof ExcludeRules];
  }
  return { ...filters, exclude };
}

export function clearExclude(filters: VoterFilters): VoterFilters {
  return { ...filters, exclude: {} };
}

export function excludeAttrActive(
  exclude: ExcludeRules | undefined,
  attr: ExcludeAttrKey,
): boolean {
  const ex = exclude ?? {};
  if (attr === 'age') return ex.age_min != null || ex.age_max != null;
  if (attr === 'support_score') {
    return ex.support_score_min != null || ex.support_score_max != null;
  }
  if (
    attr === 'has_volunteer' ||
    attr === 'has_yard_sign' ||
    attr === 'has_donated' ||
    attr === 'campaign_volunteer'
  ) {
    return ex[attr] === true;
  }
  const vals = ex[attr as keyof ExcludeRules];
  return Array.isArray(vals) && vals.length > 0;
}

export function summarizeFilters(f: VoterFilters): string[] {
  const parts: string[] = [];
  const tag = (label: string, values?: string[]) => {
    if (values?.length) parts.push(`${label}: ${values.join(', ')}`);
  };

  tag('County', f.county);
  tag('Party', f.party);
  tag('City', f.city);
  tag('ZIP', f.zip);
  tag('Status', f.status);
  tag('State', f.state?.map(formatStateFilterValue));
  if (f.age_min != null || f.age_max != null) {
    parts.push(`Age: ${f.age_min ?? '…'}–${f.age_max ?? '…'}`);
  }
  if (f.support_score_min != null || f.support_score_max != null) {
    parts.push(
      `Support: ${f.support_score_min ?? '…'}–${f.support_score_max ?? '…'}`,
    );
  }
  if (f.signed?.length) {
    const labels = f.signed.map((k) => petitionLabel(k));
    parts.push(`Signed: ${labels.join(' + ')}`);
  }
  if (f.signed_any) parts.push('Signed any petition');
  if (f.signed_all_core) parts.push('Signed all three core petitions');
  if (f.signed_min != null && f.signed_min > 0) {
    const of = f.signed_min_of?.length
      ? ` of ${f.signed_min_of.map((k) => petitionLabel(k)).join(', ')}`
      : '';
    parts.push(
      f.signed_min === 2
        ? `Super signers (2+${of})`
        : `Signed ≥${f.signed_min}${of}`,
    );
  }
  tag('Alignment', f.alignment_label);
  tag('Yard sign', f.yard_sign);
  tag('Volunteer', f.volunteer_interest);
  tag('Newsletter', f.newsletter);
  tag('Donated', f.donated);
  tag('Attended event', f.attended_event);
  tag('Topic', f.top_main_topic);
  tag('Convo support', f.convos_candidate_support);
  tag('Convo status', f.convos_contact_status);
  if (f.has_volunteer) parts.push('Has volunteer interest');
  if (f.has_yard_sign) parts.push('Has yard sign');
  if (f.has_donated) parts.push('Has donated');

  const yardMin = f.nearby_yard_sign_min_miles;
  const yardMax =
    f.nearby_yard_sign_max_miles ?? f.nearby_yard_sign_miles ?? null;
  const volMin = f.nearby_volunteer_min_miles;
  const volMax =
    f.nearby_volunteer_max_miles ?? f.nearby_volunteer_miles ?? null;
  if (yardMin != null || yardMax != null) {
    parts.push(
      `Yard sign ${yardMin ?? 0}–${yardMax != null ? `${yardMax} mi` : '∞'}`,
    );
  }
  if (volMin != null || volMax != null) {
    parts.push(
      `Volunteer ${volMin ?? 0}–${volMax != null ? `${volMax} mi` : '∞'}`,
    );
  }
  tag('Tag', f.supporter_tag);
  if (f.possible_duplicates) parts.push('Possible duplicates');
  if (f.any_of?.length) {
    parts.push(
      `Match any: ${f.any_of.map((r) => summarizeAnyOfRule(r)).join(' OR ')}`,
    );
  }

  const ex = f.exclude ?? {};
  if (ex.signed?.length) {
    const labels = ex.signed.map((k) => petitionLabel(k));
    parts.push(`Exclude signed: ${labels.join(', ')}`);
  }
  tag('Exclude tag', ex.supporter_tag);
  tag('Exclude county', ex.county);
  tag('Exclude party', ex.party);
  tag('Exclude city', ex.city);
  tag('Exclude ZIP', ex.zip);
  tag('Exclude state', ex.state?.map(formatStateFilterValue));
  tag('Exclude status', ex.status);
  tag('Exclude alignment', ex.alignment_label);
  tag('Exclude yard sign', ex.yard_sign);
  tag('Exclude volunteer', ex.volunteer_interest);
  tag('Exclude newsletter', ex.newsletter);
  tag('Exclude donated', ex.donated);
  tag('Exclude attended', ex.attended_event);
  tag('Exclude topic', ex.top_main_topic);
  tag('Exclude convo support', ex.convos_candidate_support);
  tag('Exclude convo status', ex.convos_contact_status);
  if (ex.age_min != null || ex.age_max != null) {
    parts.push(`Exclude age: ${ex.age_min ?? '…'}–${ex.age_max ?? '…'}`);
  }
  if (ex.support_score_min != null || ex.support_score_max != null) {
    parts.push(
      `Exclude support: ${ex.support_score_min ?? '…'}–${ex.support_score_max ?? '…'}`,
    );
  }
  if (ex.has_volunteer) parts.push('Exclude has volunteer');
  if (ex.has_yard_sign) parts.push('Exclude has yard sign');
  if (ex.has_donated) parts.push('Exclude has donated');
  if (ex.campaign_volunteer) parts.push('Exclude campaign volunteers');

  return parts;
}

export function setAnyOf(
  filters: VoterFilters,
  any_of: FilterAnyOfRule[],
): VoterFilters {
  return { ...filters, any_of };
}

export function addAnyOfRule(
  filters: VoterFilters,
  rule: FilterAnyOfRule,
): VoterFilters {
  if (!rule.values?.length) return filters;
  return { ...filters, any_of: [...(filters.any_of ?? []), rule] };
}

export function removeAnyOfRule(
  filters: VoterFilters,
  index: number,
): VoterFilters {
  const next = [...(filters.any_of ?? [])];
  next.splice(index, 1);
  return { ...filters, any_of: next };
}

export function toggleSigned(
  filters: VoterFilters,
  key: SignedPetitionKey,
): VoterFilters {
  const current = filters.signed ?? [];
  const next = current.includes(key)
    ? current.filter((k) => k !== key)
    : [...current, key];
  return { ...filters, signed: next };
}
