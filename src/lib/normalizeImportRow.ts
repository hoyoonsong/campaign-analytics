import { slugFromPetitionTarget } from '../components/ImportMappingModal';
import { VOTER_FIELDS, type VoterFieldKey } from './types';

const SIG_FIELD_TO_SLUG: Record<string, string> = {
  sig_open_primaries: 'open_primaries',
  sig_reproductive_freedom: 'reproductive_freedom',
  sig_reproductive_freedom_valid_code: 'reproductive_freedom',
  sig_achilles_petition: 'achilles',
  sig_medical_cannabis: 'medical_cannabis',
  sig_medical_marijuana_valid_code: 'medical_marijuana_valid',
};

export function normalizeImportRow(row: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const signatures: Record<string, string> = {};

  for (const field of VOTER_FIELDS) {
    const key = field.key as VoterFieldKey;
    const raw = row[key];
    if (raw == null || raw === '') {
      out[key] = null;
      continue;
    }
    if (key === 'age' || key === 'support_score') {
      const n = Number.parseInt(raw, 10);
      out[key] = Number.isFinite(n) ? n : null;
    } else if (key === 'lat' || key === 'lng') {
      const n = Number.parseFloat(raw);
      out[key] = Number.isFinite(n) ? n : null;
    } else if (key === 'state') {
      out[key] = raw.slice(0, 2).toUpperCase();
    } else {
      out[key] = raw;
    }
    const slug = SIG_FIELD_TO_SLUG[key];
    if (slug && raw) signatures[slug] = raw;
  }

  for (const [key, raw] of Object.entries(row)) {
    const slug = slugFromPetitionTarget(key);
    if (slug && raw) signatures[slug] = raw;
  }

  if (Object.keys(signatures).length) out.signatures = signatures;
  return out;
}
