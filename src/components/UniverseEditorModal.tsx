import { useEffect, useMemo, useState } from 'react';
import { Modal } from './ui';
import { emptyFilters, toggleSigned } from '../lib/filters';
import { usePetitions } from '../lib/petitions';
import { SUPPORT_SCORE_LABELS } from '../lib/supporterPresets';
import type {
  FilterAnyOfField,
  FilterAnyOfRule,
  SavedUniverse,
  VoterFilters,
} from '../lib/types';

type Chip = { value: string; label: string };

const FORMHANDLER_FLAGS: { field: FilterAnyOfField; label: string }[] = [
  { field: 'campaign_volunteer', label: 'Volunteer' },
  { field: 'campaign_donor', label: 'Donor' },
  { field: 'campaign_attendee', label: 'Event attendee' },
  { field: 'campaign_yard_sign', label: 'Yard sign' },
  { field: 'campaign_newsletter', label: 'Newsletter' },
];

const FIELD_CHIPS: {
  title: string;
  field: Exclude<FilterAnyOfField, 'support_score'>;
  chips: Chip[];
}[] = [
  {
    title: 'Yard sign (voter file)',
    field: 'yard_sign',
    chips: [
      { value: 'Yes', label: 'Yes' },
      { value: 'Delivered', label: 'Delivered' },
    ],
  },
  {
    title: 'Donated (voter file)',
    field: 'donated',
    chips: [{ value: 'Yes', label: 'Yes' }],
  },
  {
    title: 'Volunteer interest (voter file)',
    field: 'volunteer_interest',
    chips: [{ value: 'Yes', label: 'Yes' }],
  },
  {
    title: 'Attended event (voter file)',
    field: 'attended_event',
    chips: [{ value: 'Yes', label: 'Yes' }],
  },
  {
    title: 'Newsletter (voter file)',
    field: 'newsletter',
    chips: [{ value: 'Yes', label: 'Yes' }],
  },
  {
    title: 'Alignment',
    field: 'alignment_label',
    chips: [
      { value: 'Positive', label: 'Positive' },
      { value: 'Neutral', label: 'Neutral' },
      { value: 'Negative', label: 'Negative' },
    ],
  },
  {
    title: 'Convos — candidate support',
    field: 'convos_candidate_support',
    chips: [
      { value: 'yes', label: 'Yes' },
      { value: 'maybe', label: 'Maybe' },
      { value: 'no', label: 'No' },
    ],
  },
  {
    title: 'Convos — poll question',
    field: 'convos_poll_question',
    chips: [
      { value: 'A) Yes', label: 'A) Yes' },
      { value: 'B) No', label: 'B) No' },
      { value: 'C) Not Sure', label: 'C) Not Sure' },
    ],
  },
  {
    title: 'Convos — contact status',
    field: 'convos_contact_status',
    chips: [
      { value: 'ACTIVE', label: 'Active' },
      { value: 'HOSTILE', label: 'Hostile' },
      { value: 'STOPPED', label: 'Stopped' },
    ],
  },
];

function ruleFor(
  anyOf: FilterAnyOfRule[],
  field: FilterAnyOfField,
): FilterAnyOfRule | undefined {
  return anyOf.find((r) => r.field === field);
}

function stringValues(rule: FilterAnyOfRule | undefined): string[] {
  return (rule?.values as string[] | undefined) ?? [];
}

function numberValues(rule: FilterAnyOfRule | undefined): number[] {
  return (rule?.values as number[] | undefined) ?? [];
}

function replaceRule(
  filters: VoterFilters,
  field: FilterAnyOfField,
  next: FilterAnyOfRule | null,
): VoterFilters {
  const rest = (filters.any_of ?? []).filter((r) => r.field !== field);
  return {
    ...filters,
    any_of: next && next.values.length ? [...rest, next] : rest,
  };
}

function toggleStringValue(
  filters: VoterFilters,
  field: Exclude<FilterAnyOfField, 'support_score'>,
  value: string,
): VoterFilters {
  const current = stringValues(ruleFor(filters.any_of ?? [], field));
  const values = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
  return replaceRule(
    filters,
    field,
    values.length ? { field, values } : null,
  );
}

function toggleYesFlag(filters: VoterFilters, field: FilterAnyOfField): VoterFilters {
  const current = stringValues(ruleFor(filters.any_of ?? [], field));
  const on = current.some((v) => v.toLowerCase() === 'yes');
  return replaceRule(
    filters,
    field,
    on ? null : { field, values: ['Yes'] },
  );
}

function toggleScore(filters: VoterFilters, n: number): VoterFilters {
  const current = numberValues(ruleFor(filters.any_of ?? [], 'support_score'));
  const values = current.includes(n)
    ? current.filter((v) => v !== n)
    : [...current, n].sort((a, b) => a - b);
  return replaceRule(
    filters,
    'support_score',
    values.length ? { field: 'support_score', values } : null,
  );
}

function ChipButton({
  on,
  label,
  onClick,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        on
          ? 'rounded-full border border-brand-500 bg-brand-50 px-3 py-1 text-xs font-medium text-brand-800'
          : 'rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 hover:border-slate-300'
      }
    >
      {label}
    </button>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        {hint ? <p className="text-[11px] text-slate-500">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function UniverseEditorModal({
  open,
  universe,
  isEdit = false,
  saving,
  error,
  onClose,
  onSave,
}: {
  open: boolean;
  universe: SavedUniverse | null;
  isEdit?: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (next: {
    name: string;
    filters: VoterFilters;
    supporter_tag: string | null;
    tag_priority: number;
  }) => void;
}) {
  const { activePetitions } = usePetitions();
  const [name, setName] = useState('');
  const [supporterTag, setSupporterTag] = useState('');
  const [tagPriority, setTagPriority] = useState(0);
  const [filters, setFilters] = useState<VoterFilters>(emptyFilters());

  useEffect(() => {
    if (!open) return;
    if (universe) {
      setName(universe.name);
      setSupporterTag(universe.supporter_tag ?? '');
      setTagPriority(universe.tag_priority ?? 0);
      setFilters({ ...emptyFilters(), ...universe.filters });
    } else {
      setName('');
      setSupporterTag('');
      setTagPriority(0);
      setFilters(emptyFilters());
    }
  }, [open, universe]);

  const signedOn = useMemo(() => {
    const set = new Set(filters.signed ?? []);
    if (filters.signed_min != null && filters.signed_min > 0) {
      for (const s of filters.signed_min_of ?? []) set.add(s);
    }
    return set;
  }, [filters.signed, filters.signed_min, filters.signed_min_of]);

  const anyOf = filters.any_of ?? [];

  const submit = () => {
    onSave({
      name: name.trim(),
      filters,
      supporter_tag: supporterTag.trim() || null,
      tag_priority: tagPriority,
    });
  };

  return (
    <Modal
      open={open}
      xl
      onClose={onClose}
      title={isEdit ? `Edit ${universe?.name ?? 'universe'}` : universe?.name || 'New universe'}
      description="People match ANY checked item below, and must have signed every checked petition."
    >
      <div className="space-y-5">
        {error ? (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="label">Name</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Achilles Vote"
            />
          </label>
          <label className="block">
            <span className="label">Supporter tag (optional)</span>
            <select
              className="input"
              value={
                ['supporter', 'maybe', 'opposed'].includes(supporterTag)
                  ? supporterTag
                  : supporterTag
                    ? '__custom__'
                    : ''
              }
              onChange={(e) => {
                const v = e.target.value;
                if (v === '__custom__') {
                  setSupporterTag(supporterTag || 'custom');
                  return;
                }
                setSupporterTag(v);
                if (v === 'supporter') setTagPriority(30);
                else if (v === 'opposed') setTagPriority(20);
                else if (v === 'maybe') setTagPriority(10);
                else setTagPriority(0);
              }}
            >
              <option value="">None — filter only</option>
              <option value="supporter">supporter</option>
              <option value="maybe">maybe</option>
              <option value="opposed">opposed</option>
              {supporterTag &&
              !['supporter', 'maybe', 'opposed', ''].includes(supporterTag) ? (
                <option value="__custom__">{supporterTag}</option>
              ) : null}
            </select>
          </label>
          <label className="block">
            <span className="label">Tag priority</span>
            <input
              className="input"
              type="number"
              value={tagPriority}
              onChange={(e) => setTagPriority(Number(e.target.value) || 0)}
            />
            <span className="mt-1 block text-[11px] text-slate-500">
              Higher overwrites lower when a person matches more than one tag.
            </span>
          </label>
        </div>

        <Section
          title="Petitions"
          hint="Must have signed each checked petition (AND)."
        >
          {activePetitions.length === 0 ? (
            <p className="text-xs text-slate-400">No petitions loaded.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {activePetitions.map((p) => (
                <ChipButton
                  key={p.slug}
                  on={signedOn.has(p.slug)}
                  label={p.short_label || p.label}
                  onClick={() =>
                    setFilters((f) => {
                      const current = new Set(f.signed ?? []);
                      if (f.signed_min != null && f.signed_min > 0) {
                        for (const s of f.signed_min_of ?? []) current.add(s);
                      }
                      return toggleSigned(
                        {
                          ...f,
                          signed: [...current],
                          signed_min: null,
                          signed_min_of: [],
                        },
                        p.slug,
                      );
                    })
                  }
                />
              ))}
            </div>
          )}
        </Section>

        <Section
          title="FormHandler"
          hint="Volunteers, donors, event attendees, yard signs, and newsletters synced from FormHandler. Match any."
        >
          <div className="flex flex-wrap gap-1.5">
            {FORMHANDLER_FLAGS.map((f) => (
              <ChipButton
                key={f.field}
                on={stringValues(ruleFor(anyOf, f.field)).some(
                  (v) => v.toLowerCase() === 'yes',
                )}
                label={f.label}
                onClick={() => setFilters((cur) => toggleYesFlag(cur, f.field))}
              />
            ))}
          </div>
        </Section>

        <Section title="Convos, alignment & score" hint="Match any checked value.">
          <div className="space-y-3">
            {FIELD_CHIPS.filter((g) =>
              g.field.startsWith('convos_') || g.field === 'alignment_label',
            ).map((g) => (
              <div key={g.field}>
                <p className="mb-1 text-[11px] font-medium text-slate-600">{g.title}</p>
                <div className="flex flex-wrap gap-1.5">
                  {g.chips.map((c) => (
                    <ChipButton
                      key={c.value}
                      on={stringValues(ruleFor(anyOf, g.field)).includes(c.value)}
                      label={c.label}
                      onClick={() =>
                        setFilters((cur) => toggleStringValue(cur, g.field, c.value))
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
            <div>
              <p className="mb-1 text-[11px] font-medium text-slate-600">
                Support score
              </p>
              <div className="flex flex-wrap gap-1.5">
                {([1, 2, 3, 4, 5] as const).map((n) => (
                  <ChipButton
                    key={n}
                    on={numberValues(ruleFor(anyOf, 'support_score')).includes(n)}
                    label={SUPPORT_SCORE_LABELS[n]}
                    onClick={() => setFilters((cur) => toggleScore(cur, n))}
                  />
                ))}
              </div>
            </div>
          </div>
        </Section>

        <Section
          title="Voter file"
          hint="Yard sign, donated, volunteer interest, events, newsletter from the import. Match any."
        >
          <div className="space-y-3">
            {FIELD_CHIPS.filter(
              (g) =>
                !g.field.startsWith('convos_') && g.field !== 'alignment_label',
            ).map((g) => (
              <div key={g.field}>
                <p className="mb-1 text-[11px] font-medium text-slate-600">{g.title}</p>
                <div className="flex flex-wrap gap-1.5">
                  {g.chips.map((c) => (
                    <ChipButton
                      key={c.value}
                      on={stringValues(ruleFor(anyOf, g.field)).includes(c.value)}
                      label={c.label}
                      onClick={() =>
                        setFilters((cur) => toggleStringValue(cur, g.field, c.value))
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={saving || !name.trim()}
            onClick={submit}
          >
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create universe'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
