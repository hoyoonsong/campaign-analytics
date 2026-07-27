import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { VoterFieldKey } from '../lib/types';
import { VOTER_FIELDS } from '../lib/types';

const PREVIEW_ROWS = 5;

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
  if (key.startsWith('sig_')) return 'Signatures';
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
    murmuration_id: ['murmuration id', 'murmuration', 'murm id', 'vanid', 'van id'],
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

export function ImportMappingModal({
  title = 'Map your columns',
  headers,
  sampleRows,
  onCancel,
  onConfirm,
}: {
  title?: string;
  headers: string[];
  sampleRows: string[][];
  onCancel: () => void;
  onConfirm: (mapping: Record<VoterFieldKey, string>) => void | Promise<void>;
}) {
  const guess = useMemo(() => {
    const m: Record<string, string> = {};
    const used = new Set<string>();
    for (const h of headers) {
      const label = h.toLowerCase();
      const leaf = label.includes('>') ? label.split('>').pop()!.trim() : label;
      const hit = VOTER_IMPORT_TARGETS.find((t) => {
        if (used.has(t.key)) return false;
        return t.aliases.some(
          (a) =>
            a === leaf ||
            a === label ||
            (a.length >= 6 && (leaf.includes(a) || label.includes(a))),
        );
      });
      m[h] = hit?.key ?? '';
      if (hit) used.add(hit.key);
    }
    return m;
  }, [headers]);

  // csv header → target key
  const [colMap, setColMap] = useState<Record<string, string>>(guess);
  const [saving, setSaving] = useState(false);

  const assigned = new Set(Object.values(colMap).filter(Boolean));
  // Prefer Murmuration ID for 1:1 mapping; State Voter ID is an acceptable fallback.
  const hasIdentityKey =
    assigned.has('murmuration_id') || assigned.has('voter_id');
  const missingRequired = [
    ...VOTER_IMPORT_TARGETS.filter(
      (t) => t.required && t.key !== 'murmuration_id' && !assigned.has(t.key),
    ),
    ...(!hasIdentityKey
      ? [{ key: 'murmuration_id', label: 'Murmuration ID (or State Voter ID)' }]
      : []),
  ];

  const toTargetMapping = (): Record<VoterFieldKey, string> => {
    const out = {} as Record<VoterFieldKey, string>;
    for (const [header, target] of Object.entries(colMap)) {
      if (!target) continue;
      out[target as VoterFieldKey] = header;
    }
    return out;
  };

  const body = (
    <div className="fixed inset-0 z-[5000] flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8">
      <div className="card w-full max-w-3xl my-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="border-b border-slate-200 px-4 py-3 sm:px-5">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <p className="mt-1 text-sm text-slate-500">
            Assign each spreadsheet column to a voter field (or ignore). Same flow as
            the campaign portal.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 sm:px-5 space-y-3">
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
              </div>
              <select
                className="input"
                value={colMap[h] ?? ''}
                onChange={(e) =>
                  setColMap((m) => ({ ...m, [h]: e.target.value }))
                }
              >
                <option value="">— Ignore —</option>
                {Object.entries(
                  VOTER_IMPORT_TARGETS.reduce<Record<string, ImportTarget[]>>(
                    (acc, t) => {
                      const g = t.group ?? 'Other';
                      (acc[g] ??= []).push(t);
                      return acc;
                    },
                    {},
                  ),
                ).map(([group, targets]) => (
                  <optgroup key={group} label={group}>
                    {targets.map((t) => (
                      <option
                        key={t.key}
                        value={t.key}
                        disabled={
                          assigned.has(t.key) && colMap[h] !== t.key
                        }
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
              Murmuration ID is the preferred 1:1 key; State Voter ID also works.
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
            disabled={saving || missingRequired.length > 0}
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
