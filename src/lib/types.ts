export type ProfileRole = 'admin' | 'staff' | 'volunteer';

export interface Profile {
  id: string;
  email: string | null;
  full_name: string | null;
  role: ProfileRole | string;
}

/** Petition keys for `signed` filter (AND when include; NOT each when exclude). */
export type SignedPetitionKey =
  | 'open_primaries'
  | 'reproductive_freedom'
  | 'achilles'
  | 'medical_marijuana_valid';

/** Attributes that can be used in the Exclude Profiles builder (mirrors include filters). */
export type ExcludeAttrKey =
  | 'signed'
  | 'supporter_tag'
  | 'alignment_label'
  | 'yard_sign'
  | 'volunteer_interest'
  | 'newsletter'
  | 'donated'
  | 'attended_event'
  | 'top_main_topic'
  | 'convos_candidate_support'
  | 'convos_contact_status'
  | 'county'
  | 'party'
  | 'city'
  | 'zip'
  | 'state'
  | 'status'
  | 'age'
  | 'support_score'
  | 'has_volunteer'
  | 'has_yard_sign'
  | 'has_donated'
  | 'campaign_volunteer';

export type ExcludeRules = {
  signed?: SignedPetitionKey[];
  /** Exclude people with these supporter tags (supporter / maybe / opposed). */
  supporter_tag?: string[];
  alignment_label?: string[];
  yard_sign?: string[];
  volunteer_interest?: string[];
  newsletter?: string[];
  donated?: string[];
  attended_event?: string[];
  top_main_topic?: string[];
  convos_candidate_support?: string[];
  convos_contact_status?: string[];
  county?: string[];
  party?: string[];
  city?: string[];
  zip?: string[];
  state?: string[];
  status?: string[];
  /** Exclude people in this age band (inclusive). */
  age_min?: number | null;
  age_max?: number | null;
  /** Exclude people in this support-score band (inclusive). */
  support_score_min?: number | null;
  support_score_max?: number | null;
  has_volunteer?: boolean | null;
  has_yard_sign?: boolean | null;
  has_donated?: boolean | null;
  /** Exclude voters matched to FormHandler volunteers. */
  campaign_volunteer?: boolean | null;
};

/** One condition in an Organizer-style OR group (`any_of`). */
export type FilterAnyOfField =
  | 'yard_sign'
  | 'donated'
  | 'alignment_label'
  | 'support_score'
  | 'convos_candidate_support'
  | 'convos_poll_question'
  | 'convos_contact_status'
  | 'volunteer_interest'
  | 'newsletter'
  | 'attended_event'
  | 'top_main_topic'
  | 'county'
  | 'party'
  | 'status';

export type FilterAnyOfRule =
  | { field: 'support_score'; values: number[] }
  | { field: Exclude<FilterAnyOfField, 'support_score'>; values: string[] };

/**
 * Filters combine as:
 * - `any_of`: OR across rules (Organizer-style)
 * - other include fields: AND (arrays still OR within a field; `signed` is AND)
 * - `exclude`: AND NOT
 */
export interface VoterFilters {
  county?: string[];
  party?: string[];
  city?: string[];
  zip?: string[];
  status?: string[];
  age_min?: number | null;
  age_max?: number | null;
  support_score_min?: number | null;
  support_score_max?: number | null;
  /** Must have signed each selected petition. */
  signed?: SignedPetitionKey[];
  signed_any?: boolean | null;
  signed_all_core?: boolean | null;
  alignment_label?: string[];
  yard_sign?: string[];
  volunteer_interest?: string[];
  newsletter?: string[];
  donated?: string[];
  attended_event?: string[];
  top_main_topic?: string[];
  convos_candidate_support?: string[];
  convos_contact_status?: string[];
  has_volunteer?: boolean | null;
  has_yard_sign?: boolean | null;
  has_donated?: boolean | null;
  /** Voters with a campaign yard sign within this many miles (legacy max). */
  nearby_yard_sign_miles?: number | null;
  /** Voters with a campaign volunteer within this many miles (legacy max). */
  nearby_volunteer_miles?: number | null;
  /** Nearby yard-sign distance range (blank min=0, blank max=unbounded). */
  nearby_yard_sign_min_miles?: number | null;
  nearby_yard_sign_max_miles?: number | null;
  /** Nearby volunteer distance range (blank min=0, blank max=unbounded). */
  nearby_volunteer_min_miles?: number | null;
  nearby_volunteer_max_miles?: number | null;
  /** Supporter tags: supporter | maybe | opposed (and custom). */
  supporter_tag?: string[];
  /** US state codes (e.g. ID, OR). */
  state?: string[];
  /** Match if ANY of these rules is true (cross-field OR). */
  any_of?: FilterAnyOfRule[];
  /** Separate exclude rules (Organizer-style Exclude Profiles). */
  exclude?: ExcludeRules;
}

export const SIGNED_PETITION_OPTIONS: { key: SignedPetitionKey; label: string }[] = [
  { key: 'open_primaries', label: 'Open Primaries' },
  {
    key: 'reproductive_freedom',
    label: 'Reproductive Freedom (True or VAL)',
  },
  { key: 'achilles', label: 'Achilles Petition' },
  { key: 'medical_marijuana_valid', label: 'Medical Marijuana (VAL)' },
];

export interface VoterRow {
  id: number;
  murmuration_id?: string | null;
  voter_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line_1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  county: string | null;
  party: string | null;
  age: number | null;
  status: string | null;
  support_score?: number | null;
  lat?: number | null;
  lng?: number | null;
  supporter_tag?: string | null;
  is_campaign_volunteer?: boolean | null;
  campaign_person_id?: string | null;
  nearby_yard_sign_miles?: number | null;
  nearby_volunteer_miles?: number | null;
}

export interface MapPoint {
  id: number;
  murmuration_id?: string | null;
  voter_id: string | null;
  first_name: string | null;
  last_name: string | null;
  address_line_1: string | null;
  city: string | null;
  county: string | null;
  zip: string | null;
  party: string | null;
  status: string | null;
  age: number | null;
  support_score: number | null;
  lat: number;
  lng: number;
}

export interface CountBucket {
  key: string;
  count: number;
}

export interface SignatureStats {
  open_primaries: number;
  reproductive_freedom: number;
  achilles_petition: number;
  medical_cannabis: number;
  medical_marijuana_valid: number;
  reproductive_freedom_valid: number;
  signed_all_core: number;
  signed_all_four: number;
  signed_any: number;
}

export interface AnalyticsSummary {
  total: number;
  with_coords: number;
  by_county: CountBucket[];
  by_party: CountBucket[];
  by_status: CountBucket[];
  by_age: CountBucket[];
  by_supporter_tag?: CountBucket[];
  supporters?: number;
  maybes?: number;
  opposed?: number;
  /** Total voters in DB (unfiltered) — for share-of-universe %. */
  universe_total?: number;
  signatures?: SignatureStats;
  by_signature?: CountBucket[];
  by_petition_count?: CountBucket[];
  /** Mean miles to nearest FormHandler yard sign (sample of matching voters with coords). */
  avg_nearby_yard_sign_miles?: number | null;
  /** Mean miles to nearest FormHandler volunteer pin. */
  avg_nearby_volunteer_miles?: number | null;
  avg_nearby_sample_size?: number | null;
  avg_nearby_scope?: string | null;
  avg_nearby_computed_at?: string | null;
}

export interface SavedUniverse {
  id: string;
  name: string;
  filters: VoterFilters;
  supporter_tag?: string | null;
  tag_priority?: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignSyncState {
  id: number;
  last_success_at: string | null;
  volunteer_count: number;
  yard_sign_count: number;
  matched_voter_count: number;
  geo_point_count: number;
  last_error: string | null;
  updated_at: string;
  avg_nearby_yard_sign_miles?: number | null;
  avg_nearby_volunteer_miles?: number | null;
  avg_nearby_sample_size?: number | null;
  avg_nearby_scope?: string | null;
  avg_nearby_computed_at?: string | null;
  universe_total?: number | null;
}

export interface DbUsage {
  voter_count: number;
  table_size: string;
  index_size: string;
  total_relation_size: string;
  database_size: string;
  table_size_bytes: number;
  index_size_bytes: number;
  total_relation_size_bytes: number;
  database_size_bytes: number;
}

/** Importable columns — labels match common PDI / Achilles export headers. */
export const VOTER_FIELDS = [
  { key: 'murmuration_id', label: 'Murmuration ID', required: true },
  { key: 'voter_id', label: 'State Voter ID' },
  { key: 'first_name', label: 'First Name' },
  { key: 'last_name', label: 'Last Name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone (Best Known)' },
  { key: 'age', label: 'Age' },
  { key: 'address_line_1', label: 'Address 1 - Residence' },
  { key: 'city', label: 'City - Residence' },
  { key: 'county', label: 'County - Residence' },
  { key: 'zip', label: 'Zip Code - Residence' },
  { key: 'state', label: 'State - Residence' },
  { key: 'lat', label: 'Latitude - Residence' },
  { key: 'lng', label: 'Longitude - Residence' },
  { key: 'party', label: 'Registered Party' },
  { key: 'voter_registered', label: 'Voter Registered' },
  { key: 'status', label: 'Voter Status' },
  { key: 'sig_open_primaries', label: 'Open Primaries Petition' },
  { key: 'sig_reproductive_freedom', label: 'Reproductive Freedom Signature' },
  { key: 'sig_achilles_petition', label: 'Achilles Petition Signature' },
  { key: 'sig_medical_cannabis', label: 'Idaho Medical Cannabis Act' },
  {
    key: 'sig_medical_marijuana_valid_code',
    label: 'Idaho Medical Marijuana Act Signature Valid Code',
  },
  {
    key: 'sig_reproductive_freedom_valid_code',
    label: 'Idaho Reproductive Freedom Act Valid Code',
  },
  { key: 'volunteer_interest', label: 'Volunteer interest' },
  { key: 'yard_sign', label: 'Yard Sign' },
  { key: 'support_score', label: 'Support Score 1-5 (2026)' },
  { key: 'newsletter', label: 'Newsletter' },
  { key: 'legacy_volunteer', label: 'Legacy Volunteer' },
  { key: 'alignment_score', label: 'Alignment Score' },
  { key: 'top_main_topic', label: 'Top Main Topic' },
  { key: 'alignment_label', label: 'Alignment label' },
  { key: 'contact_tags', label: 'Contact Tags' },
  { key: 'convos_candidate_support', label: 'Convos - Candidate Support' },
  { key: 'convos_contact_status', label: 'Convos - Contact Status' },
  { key: 'convos_poll_question', label: 'Convos - Poll Question' },
  { key: 'donated', label: 'Donated' },
  { key: 'attended_event', label: 'Attended event' },
] as const;

export type VoterFieldKey = (typeof VOTER_FIELDS)[number]['key'];
