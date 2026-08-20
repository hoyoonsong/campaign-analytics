import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { VOTER_FIELDS } from '../lib/types';
import type { Petition } from '../lib/petitions';

const PREVIEW_ROWS = 5;
export const PETITION_TARGET_PREFIX = 'petition:';

export function petitionTargetKey(slug: string) {
  return `${PETITION_TARGET_PREFIX}${slug}`;
}

export function slugFromPetitionTarget(key: string): string | null {
  return key.startsWith(PETITION_TARGET_PREFIX)
    ? key.slice(PETITION_TARGET_PREFIX.length)
    : null;
}

export interface ImportTarget {
  key: string;
  label: string;
  aliases: string[];
  required?: boolean;
  group?: string;
}

export const VOTER_IMPORT_TARGETS: ImportTarget[] = VOTER_FIELDS.map((f) => ({
  key: f.key,
  label: f.label,
  required: 'required' in f && !!f.required,
  group: groupFor(f.key),
  aliases: aliasesFor(f.key, f.label),
}));

function groupFor(key: string): string {
  if (
    [
      'murmuration_id',
      'voter_id',
      'first_name',
      'last_name',
      'email',
      'phone',
      'age',
    ].includes(key)
  ) {
    return 'Contact';
  }
  if (
    ['address_line_1', 'city', 'county', 'zip', 'state', 'lat', 'lng'].includes(key)
  ) {
    return 'Location';
  }
  if (['party', 'voter_registered', 'status'].includes(key)) return 'Registration';
  if (key.startsWith('sig_') || key.startsWith(PETITION_TARGET_PREFIX)) {
    return 'Signatures';
  }
  if (
    ['volunteer_interest', 'yard_sign', 'support_score', 'newsletter', 'legacy_volunteer'].includes(
      key,
    )
  ) {
    return 'Field';
  }
  if (
    key.startsWith('convos_') ||
    ['alignment_score', 'top_main_topic', 'alignment_label', 'contact_tags'].includes(key)
  ) {
    return 'Convos';
  }
  return 'Metrics';
}

function aliasesFor(key: string, label: string): string[] {
  const base = [
    key,
    key.replace(/_/g, ' '),
    label.toLowerCase(),
    label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
  ];
  const extra: Record<string, string[]> = {
    murmuration_id: [
      'murmuration id',
      'murmuration',
      'murm id',
      'vanid',
      'van id',
      'profileid',
      'profile id',
      'external id',
    ],
    voter_id: ['state voter id', 'voter id', 'voterid'],
    first_name: ['first name', 'firstname', 'names > first name'],
    last_name: ['last name', 'lastname', 'names > last name'],
    email: ['email address', 'email', 'contact > email'],
    phone: ['phone number', 'best known', 'phone number - best known'],
    address_line_1: ['address 1', 'address 1 - residence', 'residence'],
    city: ['city - residence'],
    county: ['county - residence'],
    zip: ['zip code', 'zip code - residence'],
    state: ['state - residence'],
    lat: ['latitude', 'latitude - residence'],
    lng: ['longitude', 'longitude - residence'],
    party: ['registered party'],
    status: ['voter status'],
  };
  return [...base, ...(extra[key] ?? [])];
}

export function headerLeaf(header: string): string {
  const trimmed = header.trim();
  return trimmed.includes('>') ? trimmed.split('>').pop()!.trim() : trimmed;
}

function normalizeMatchKey(s: string): string {
  return headerLeaf(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function corePetitionKey(s: string): string {
  return normalizeMatchKey(s)
    .replace(
      /\b(petition|petitions|signature|signatures|sign|valid|code|act|idaho)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function aliasesMatchHeader(header: string, aliases: string[]): boolean {
  const h = normalizeMatchKey(header);
  const hCore = corePetitionKey(header);
  if (!h) return false;
  return aliases.some((a) => {
    const n = normalizeMatchKey(a);
    const c = corePetitionKey(a);
    if (!n) return false;
    if (n === h || a.toLowerCase() === header.toLowerCase()) return true;
    if (c && hCore && c === hCore && c.length >= 4) return true;
    if (n.length >= 6 && (h.includes(n) || n.includes(h))) return true;
    return false;
  });
}

export function looksLikePetitionHeader(header: string): boolean {
  const lower = header.toLowerCase();
  const leaf = headerLeaf(lower);
  if (/\b(petition|petitions|signature|signatures)\b/.test(leaf)) return true;
  if (/>\s*signatures\s*>/.test(lower) || /signatures\s*>/.test(lower)) return true;
  return false;
}

function petitionTargetFrom(p: Petition): ImportTarget {
  return {
    key: petitionTargetKey(p.slug),
    label: p.label,
    group: 'Signatures',
    aliases: [
      p.slug,
      p.slug.replace(/_/g, ' '),
      p.label.toLowerCase(),
      p.short_label.toLowerCase(),
    ],
  };
}

export function ImportMappingModal({
  title = 'Map your columns',
  description,
  headers,
  sampleRows,
  petitions = [],
  targets: targetsOverride,
  extraTargets = [],
  onCreatePetition,
  onCancel,
  onConfirm,
}: {
  title?: string;
  description?: string;
  headers: string[];
  sampleRows: string[][];
  petitions?: Petition[];
  targets?: ImportTarget[];
  extraTargets?: ImportTarget[];
  onCreatePetition?: (label: string) => Promise<Petition | null>;
  onCancel: () => void;
  onConfirm: (mapping: Record<string, string>) => void | Promise<void>;
}) {
  const [createdPetitions, setCreatedPetitions] = useState<Petition[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const touched = useRef(new Set<string>());

  const allPetitions = useMemo(() => {
    const seen = new Set(petitions.map((p) => p.slug));
    return [
      ...petitions,
      ...createdPetitions.filter((p) => !seen.has(p.slug)),
    ];
  }, [petitions, createdPetitions]);

  const voterTargets = useMemo(() => {
    const base = VOTER_IMPORT_TARGETS.filter((t) => !t.key.startsWith('sig_'));
    const sigs: ImportTarget[] = allPetitions.map(petitionTargetFrom);
    // Keep legacy sig_* aliases so old CSV headers still auto-guess.
    for (const f of VOTER_FIELDS.filter((x) => x.key.startsWith('sig_'))) {
      const slug =
        f.key === 'sig_open_primaries'
          ? 'open_primaries'
          : f.key === 'sig_reproductive_freedom' ||
              f.key === 'sig_reproductive_freedom_valid_code'
            ? 'reproductive_freedom'
            : f.key === 'sig_achilles_petition'
              ? 'achilles'
              : f.key === 'sig_medical_cannabis'
                ? 'medical_cannabis'
                : f.key === 'sig_medical_marijuana_valid_code'
                  ? 'medical_marijuana_valid'
                  : null;
      if (!slug) continue;
      const t = sigs.find((s) => s.key === petitionTargetKey(slug));
      if (t) t.aliases.push(...aliasesFor(f.key, f.label));
    }
    return [...base, ...sigs];
  }, [allPetitions]);

  const targets = targetsOverride ?? [...voterTargets, ...extraTargets];

  const guess = useMemo(() => {
    const m: Record<string, string> = {};
    const used = new Set<string>();
    for (const h of headers) {
      const hit = targets.find((t) => {
        if (used.has(t.key)) return false;
        return aliasesMatchHeader(h, t.aliases);
      });
      m[h] = hit?.key ?? '';
      if (hit) used.add(hit.key);
    }
    return m;
  }, [headers, targets]);

  const [colMap, setColMap] = useState<Record<string, string>>(guess);
  const [saving, setSaving] = useState(false);

  // Fill still-untouched columns when petitions load or a new one is created.
  // Do not overwrite a column the user already set (including explicit Ignore).
  useEffect(() => {
    setColMap((prev) => {
      const used = new Set(
        Object.values(prev).filter((v) => v && v !== '__new_petition__'),
      );
      let changed = false;
      const next = { ...prev };
      for (const h of headers) {
        if (touched.current.has(h)) continue;
        if (next[h]) continue;
        const guessed = guess[h];
        if (guessed && !used.has(guessed)) {
          next[h] = guessed;
          used.add(guessed);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [guess, headers]);

  const assigned = new Set(Object.values(colMap).filter(Boolean));
  const hasIdentityKey = targetsOverride
    ? assigned.has('source_profile_id') ||
      assigned.has('source_phone') ||
      assigned.has('source_email') ||
      assigned.has('murmuration_id')
    : assigned.has('murmuration_id') || assigned.has('voter_id');
  const hasPollColumn = [...assigned].some(
    (k) => k.startsWith('poll:') || k === 'raw_answer',
  );
  const missingRequired = targetsOverride
    ? [
        ...(!hasIdentityKey
          ? [{ key: 'id', label: 'Profile ID, phone, or email' }]
          : []),
        ...(!hasPollColumn
          ? [{ key: 'poll', label: 'at least one poll column' }]
          : []),
      ]
    : [
        ...VOTER_IMPORT_TARGETS.filter(
          (t) => t.required && t.key !== 'murmuration_id' && !assigned.has(t.key),
        ),
        ...(!hasIdentityKey
          ? [{ key: 'murmuration_id', label: 'Murmuration ID (or State Voter ID)' }]
          : []),
      ];

  const unmappedPetitionHeaders = headers.filter(
    (h) => !colMap[h] && looksLikePetitionHeader(h),
  );

  const toTargetMapping = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [header, target] of Object.entries(colMap)) {
      if (!target || target === '__new_petition__') continue;
      out[target] = header;
    }
    return out;
  };

  const applyCreated = (header: string, created: Petition) => {
    setCreatedPetitions((cur) =>
      cur.some((p) => p.slug === created.slug) ? cur : [...cur, created],
    );
    touched.current.add(header);
    setColMap((m) => ({ ...m, [header]: petitionTargetKey(created.slug) }));
  };

  const createForHeader = async (header: string, suggested: string) => {
    if (!onCreatePetition) return;
    const label = window.prompt('New petition name', suggested);
    if (!label?.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await onCreatePetition(label.trim());
      if (!created?.slug) {
        setCreateError('Could not create petition.');
        return;
      }
      applyCreated(header, created);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create petition');
    } finally {
      setCreating(false);
    }
  };

  const addUnmappedPetitions = async () => {
    if (!onCreatePetition || unmappedPetitionHeaders.length === 0) return;
    setCreating(true);
    setCreateError(null);
    try {
      for (const h of unmappedPetitionHeaders) {
        const created = await onCreatePetition(headerLeaf(h));
        if (!created?.slug) {
          setCreateError(`Could not create petition from “${headerLeaf(h)}”.`);
          break;
        }
        applyCreated(h, created);
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create petition');
    } finally {
      setCreating(false);
    }
  };

  const handleSelect = async (header: string, value: string) => {
    if (value === '__new_petition__' && onCreatePetition) {
      await createForHeader(header, headerLeaf(header));
      return;
    }
    touched.current.add(header);
    setColMap((m) => ({ ...m, [header]: value }));
  };

  const groupedTargets = useMemo(() => {
    const acc: Record<string, ImportTarget[]> = {};
    for (const t of targets) {
      const g = t.group ?? 'Other';
      (acc[g] ??= []).push(t);
    }
    if (onCreatePetition && !acc.Signatures) acc.Signatures = [];
    return acc;
  }, [targets, onCreatePetition]);

  const body = (
    <div className="fixed inset-0 z-[5000] flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8">
      <div className="card w-full max-w-3xl my-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="border-b border-slate-200 px-4 py-3 sm:px-5">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <p className="mt-1 text-sm text-slate-500">
            {description ??
              'Assign each spreadsheet column to a voter field (or ignore). Same flow as the campaign portal. Signature columns can be mapped to a petition or added as a new one — they should not stay on Ignore.'}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 sm:px-5 space-y-3">
          {createError ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {createError}
            </p>
          ) : null}

          {onCreatePetition && unmappedPetitionHeaders.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <p>
                {unmappedPetitionHeaders.length === 1
                  ? '1 signature column is set to Ignore.'
                  : `${unmappedPetitionHeaders.length} signature columns are set to Ignore.`}{' '}
                Add them as petitions so they import.
              </p>
              <button
                type="button"
                className="btn-secondary shrink-0 text-xs"
                disabled={creating}
                onClick={() => void addUnmappedPetitions()}
              >
                {creating ? 'Adding…' : 'Add as petitions'}
              </button>
            </div>
          ) : null}

          {headers.map((h) => (
            <div
              key={h}
              className="grid gap-2 sm:grid-cols-[1fr_220px] sm:items-center"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800" title={h}>
                  {h}
                </p>
                <p className="truncate text-xs text-slate-400">
                  e.g. {sampleRows[0]?.[headers.indexOf(h)] || '—'}
                </p>
                {!colMap[h] && onCreatePetition && looksLikePetitionHeader(h) ? (
                  <button
                    type="button"
                    className="mt-0.5 text-xs font-medium text-brand-700 hover:underline"
                    disabled={creating}
                    onClick={() => void createForHeader(h, headerLeaf(h))}
                  >
                    Add as petition
                  </button>
                ) : null}
              </div>
              <select
                className="input"
                value={
                  colMap[h] && colMap[h] !== '__new_petition__'
                    ? colMap[h]
                    : ''
                }
                disabled={creating}
                onChange={(e) => void handleSelect(h, e.target.value)}
              >
                <option value="">— Ignore —</option>
                {colMap[h] &&
                colMap[h] !== '__new_petition__' &&
                !targets.some((t) => t.key === colMap[h]) ? (
                  <option value={colMap[h]}>
                    {slugFromPetitionTarget(colMap[h]) || colMap[h]}
                  </option>
                ) : null}
                {Object.entries(groupedTargets).map(([group, groupTargets]) => (
                  <optgroup key={group} label={group}>
                    {group === 'Signatures' && onCreatePetition ? (
                      <option value="__new_petition__">New petition…</option>
                    ) : null}
                    {groupTargets.map((t) => (
                      <option
                        key={t.key}
                        value={t.key}
                        disabled={assigned.has(t.key) && colMap[h] !== t.key}
                      >
                        {t.label}
                        {t.required ? ' *' : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          ))}

          <div className="overflow-x-auto rounded-md border border-slate-200">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  {headers.slice(0, 8).map((h) => (
                    <th key={h} className="px-2 py-2 font-medium">
                      {colMap[h] || h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sampleRows.slice(0, PREVIEW_ROWS).map((row, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    {headers.slice(0, 8).map((h, j) => (
                      <td key={h} className="px-2 py-1.5 text-slate-700">
                        {row[j] || '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {missingRequired.length > 0 && (
            <p className="text-sm text-amber-700">
              Required: map {missingRequired.map((t) => t.label).join(', ')}.
              {targetsOverride
                ? ''
                : ' Murmuration ID is the preferred 1:1 key; State Voter ID also works.'}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={saving || creating || missingRequired.length > 0}
            onClick={() => {
              setSaving(true);
              void Promise.resolve(onConfirm(toTargetMapping())).finally(() =>
                setSaving(false),
              );
            }}
          >
            {saving ? 'Working…' : 'Confirm mapping'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}
