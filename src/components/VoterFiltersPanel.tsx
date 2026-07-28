import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ExcludeAttrKey,
  FilterAnyOfField,
  FilterAnyOfRule,
  SignedPetitionKey,
  VoterFilters,
} from "../lib/types";
import { SIGNED_PETITION_OPTIONS } from "../lib/types";
import {
  addAnyOfRule,
  clearExclude,
  clearExcludeAttr,
  emptyFilters,
  excludeAttrActive,
  removeAnyOfRule,
  setExcludeRange,
  setExcludeValues,
  STATE_BLANK,
  summarizeFilters,
} from "../lib/filters";
import {
  idahoCityOptions,
  idahoCountyOptions,
} from "../lib/idahoPlaces";
import {
  SUPPORT_SCORE_LABELS,
  summarizeAnyOfRule,
} from "../lib/supporterPresets";

function stateFilterValues(states: string[]): string[] {
  const rest = states.filter((s) => s !== STATE_BLANK && s.trim() !== "");
  return [STATE_BLANK, ...rest];
}

const STATE_VALUE_LABELS: Record<string, string> = {
  [STATE_BLANK]: "(Blank)",
};
export interface FilterOptions {
  counties: string[];
  parties: string[];
  statuses: string[];
  states: string[];
  cities: string[];
  alignment_labels: string[];
  yard_signs: string[];
  volunteer_interests: string[];
  newsletters: string[];
  donated: string[];
  attended_events: string[];
  top_main_topics: string[];
  convos_candidate_support: string[];
  convos_contact_status: string[];
}

/** Always-available dropdowns when RPC options are empty / stale API cache. */
export const FALLBACK_FILTER_OPTIONS: FilterOptions = {
  counties: [],
  parties: [],
  statuses: ["Active", "Inactive"],
  states: ["ID", "OR", "WA", "CA", "NV", "UT", "MT", "WY"],
  cities: [],
  alignment_labels: ["Positive", "Neutral", "Negative"],
  yard_signs: ["Yes", "No", "Delivered"],
  volunteer_interests: ["yes", "no", "maybe", "N/A"],
  newsletters: ["Yes", "No"],
  donated: ["Yes"],
  attended_events: ["Yes"],
  top_main_topics: [],
  convos_candidate_support: ["yes", "no", "maybe"],
  convos_contact_status: ["ACTIVE", "HOSTILE", "STOPPED"],
};

export const EMPTY_FILTER_OPTIONS: FilterOptions = {
  ...FALLBACK_FILTER_OPTIONS,
};

function mergeOptions(
  api: Partial<FilterOptions> | null | undefined,
): FilterOptions {
  const pick = (key: keyof FilterOptions): string[] => {
    const fromApi = api?.[key];
    if (Array.isArray(fromApi) && fromApi.length > 0)
      return fromApi.map(String);
    return FALLBACK_FILTER_OPTIONS[key];
  };
  const apiCounties = pick("counties");
  const apiCities = pick("cities");
  return {
    counties: idahoCountyOptions(apiCounties),
    parties: pick("parties"),
    statuses: pick("statuses"),
    states: pick("states"),
    cities: idahoCityOptions(apiCities),
    alignment_labels: pick("alignment_labels"),
    yard_signs: pick("yard_signs"),
    volunteer_interests: pick("volunteer_interests"),
    newsletters: pick("newsletters"),
    donated: pick("donated"),
    attended_events: pick("attended_events"),
    top_main_topics: pick("top_main_topics"),
    convos_candidate_support: pick("convos_candidate_support"),
    convos_contact_status: pick("convos_contact_status"),
  };
}

export { mergeOptions };

type AttrKind = "multi" | "zip" | "range" | "flag";

type AttrDef = {
  key: ExcludeAttrKey;
  label: string;
  kind: AttrKind;
  values?: string[];
  valueLabels?: Record<string, string>;
  rangeMinHint?: string;
  rangeMaxHint?: string;
};

type AttrGroup = {
  id: string;
  label: string;
  attrs?: AttrDef[];
  children?: AttrGroup[];
};

/** Same dimensions as the include filters above — stacked after include. */
function buildExcludeCatalog(opts: FilterOptions): AttrGroup[] {
  const signedValues = SIGNED_PETITION_OPTIONS.map((o) => o.key);
  const signedLabels = Object.fromEntries(
    SIGNED_PETITION_OPTIONS.map((o) => [o.key, o.label]),
  );

  return [
    {
      id: "tags",
      label: "Tags",
      attrs: [
        {
          key: "supporter_tag",
          label: "Supporter tag",
          kind: "multi",
          values: TAG_OPTIONS.map((t) => t.value),
          valueLabels: Object.fromEntries(
            TAG_OPTIONS.map((t) => [t.value, t.label]),
          ),
        },
      ],
    },
    {
      id: "petitions",
      label: "Petitions",
      attrs: [
        {
          key: "signed",
          label: "Petitions signed",
          kind: "multi",
          values: signedValues,
          valueLabels: signedLabels,
        },
      ],
    },
    {
      id: "activity",
      label: "Campaign activity",
      attrs: [
        {
          key: "has_volunteer",
          label: "Volunteer interest (Yes)",
          kind: "flag",
        },
        {
          key: "has_yard_sign",
          label: "Yard sign (Yes / Delivered)",
          kind: "flag",
        },
        { key: "has_donated", label: "Donated", kind: "flag" },
        {
          key: "campaign_volunteer",
          label: "Campaign volunteer (FormHandler)",
          kind: "flag",
        },
        {
          key: "yard_sign",
          label: "Yard sign",
          kind: "multi",
          values: opts.yard_signs,
        },
        {
          key: "volunteer_interest",
          label: "Volunteer interest",
          kind: "multi",
          values: opts.volunteer_interests,
        },
        {
          key: "newsletter",
          label: "Newsletter",
          kind: "multi",
          values: opts.newsletters,
        },
        {
          key: "donated",
          label: "Donated (value)",
          kind: "multi",
          values: opts.donated,
        },
        {
          key: "attended_event",
          label: "Attended event",
          kind: "multi",
          values: opts.attended_events,
        },
      ],
    },
    {
      id: "convos",
      label: "Convos & alignment",
      attrs: [
        {
          key: "alignment_label",
          label: "Alignment label",
          kind: "multi",
          values: opts.alignment_labels,
        },
        {
          key: "top_main_topic",
          label: "Top Main Topic",
          kind: "multi",
          values: opts.top_main_topics,
        },
        {
          key: "convos_candidate_support",
          label: "Convos - Candidate Support",
          kind: "multi",
          values: opts.convos_candidate_support,
        },
        {
          key: "convos_contact_status",
          label: "Convos - Contact Status",
          kind: "multi",
          values: opts.convos_contact_status,
        },
      ],
    },
    {
      id: "geo",
      label: "Geography & voter file",
      attrs: [
        {
          key: "county",
          label: "County",
          kind: "multi",
          values: opts.counties,
        },
        { key: "party", label: "Party", kind: "multi", values: opts.parties },
        { key: "city", label: "City", kind: "multi", values: opts.cities },
        { key: "zip", label: "ZIP", kind: "zip" },
        {
          key: "state",
          label: "State",
          kind: "multi",
          values: stateFilterValues(opts.states),
          valueLabels: STATE_VALUE_LABELS,
        },
        {
          key: "status",
          label: "Status",
          kind: "multi",
          values: opts.statuses,
        },
        {
          key: "age",
          label: "Age range",
          kind: "range",
          rangeMinHint: "Min age",
          rangeMaxHint: "Max age",
        },
        {
          key: "support_score",
          label: "Support score range",
          kind: "range",
          rangeMinHint: "Min (1–5)",
          rangeMaxHint: "Max (1–5)",
        },
      ],
    },
  ];
}

function flattenAttrs(groups: AttrGroup[]): AttrDef[] {
  const out: AttrDef[] = [];
  const walk = (nodes: AttrGroup[]) => {
    for (const n of nodes) {
      if (n.attrs) out.push(...n.attrs);
      if (n.children) walk(n.children);
    }
  };
  walk(groups);
  return out;
}

function FilterSection({
  title,
  hint,
  defaultOpen = false,
  forceOpen = false,
  badge,
  children,
}: {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  badge?: string | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = forceOpen || open;
  return (
    <section className="rounded-lg border border-slate-200/80 bg-white">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-slate-50/80"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold tracking-tight text-slate-800">
            {title}
          </span>
          {hint ? (
            <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
              {hint}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {badge ? (
            <span className="rounded-md bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700">
              {badge}
            </span>
          ) : null}
          <span className="text-xs text-slate-400">{shown ? "▾" : "▸"}</span>
        </span>
      </button>
      {shown ? (
        <div className="space-y-3 border-t border-slate-100 px-3 py-3">
          {children}
        </div>
      ) : null}
    </section>
  );
}

const TAG_OPTIONS = [
  { value: "supporter", label: "Supporter" },
  { value: "maybe", label: "Maybe" },
  { value: "opposed", label: "Opposed" },
] as const;

function DistanceRangeInputs({
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
}: {
  minValue: number | null | undefined;
  maxValue: number | null | undefined;
  onMinChange: (v: number | null) => void;
  onMaxChange: (v: number | null) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="block text-xs">
        <span className="text-slate-600">Min mi</span>
        <input
          type="number"
          min={0}
          step={0.1}
          className="input mt-1"
          placeholder="0"
          value={minValue ?? ""}
          onChange={(e) => {
            const v = e.target.value.trim();
            onMinChange(v === "" ? null : Number(v));
          }}
        />
      </label>
      <label className="block text-xs">
        <span className="text-slate-600">Max mi</span>
        <input
          type="number"
          min={0}
          step={0.1}
          className="input mt-1"
          placeholder="No max"
          value={maxValue ?? ""}
          onChange={(e) => {
            const v = e.target.value.trim();
            onMaxChange(v === "" ? null : Number(v));
          }}
        />
      </label>
    </div>
  );
}

const ANY_OF_FIELDS: { field: FilterAnyOfField; label: string }[] = [
  { field: "yard_sign", label: "Yard sign" },
  { field: "donated", label: "Donated" },
  { field: "alignment_label", label: "Alignment label" },
  { field: "support_score", label: "Support score" },
  { field: "convos_candidate_support", label: "Convos — candidate support" },
  { field: "convos_poll_question", label: "Convos — poll question" },
  { field: "volunteer_interest", label: "Volunteer interest" },
  { field: "newsletter", label: "Newsletter" },
  { field: "attended_event", label: "Attended event" },
];

export function VoterFiltersPanel({
  filters,
  onChange,
  options,
  matchCount,
  /** When true, render as a slide-over drawer (controlled by `open`). */
  asDrawer = false,
  open = true,
  onClose,
}: {
  filters: VoterFilters;
  onChange: (next: VoterFilters) => void;
  options: FilterOptions;
  matchCount?: number | null;
  asDrawer?: boolean;
  open?: boolean;
  onClose?: () => void;
}) {
  const opts = mergeOptions(options);
  const [draftField, setDraftField] = useState<FilterAnyOfField | "">(
    "",
  );
  const [draftValues, setDraftValues] = useState<string[]>([]);
  const [draftScores, setDraftScores] = useState<number[]>([]);
  const [filterQuery, setFilterQuery] = useState("");

  const q = filterQuery.trim().toLowerCase();
  const matchSection = (...labels: string[]) =>
    !q || labels.some((l) => l.toLowerCase().includes(q));

  const activeChips = useMemo(() => summarizeFilters(filters), [filters]);

  useEffect(() => {
    if (!asDrawer || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [asDrawer, open, onClose]);

  const anyOf = filters.any_of ?? [];
  const draftOptions = useMemo(() => {
    switch (draftField) {
      case "yard_sign":
        return opts.yard_signs;
      case "donated":
        return opts.donated;
      case "alignment_label":
        return opts.alignment_labels;
      case "convos_candidate_support":
        return opts.convos_candidate_support;
      case "volunteer_interest":
        return opts.volunteer_interests;
      case "newsletter":
        return opts.newsletters;
      case "attended_event":
        return opts.attended_events;
      case "convos_poll_question":
        return ["C) Not Sure", "A) Yes", "B) No"];
      default:
        return [];
    }
  }, [draftField, opts]);

  // Must run after all hooks — early return when drawer is closed.
  if (asDrawer && !open) return null;

  const setMulti = (key: keyof VoterFilters, value: string) => {
    const current = (filters[key] as string[] | undefined) ?? [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    onChange({ ...filters, [key]: next });
  };

  const toggleSigned = (key: SignedPetitionKey) => {
    const current = filters.signed ?? [];
    const next = current.includes(key)
      ? current.filter((k) => k !== key)
      : [...current, key];
    onChange({ ...filters, signed: next });
  };

  const setFlag = (
    key:
      | "signed_any"
      | "signed_all_core"
      | "has_volunteer"
      | "has_yard_sign"
      | "has_donated",
    on: boolean,
  ) => {
    onChange({ ...filters, [key]: on ? true : null });
  };

  const addDraftRule = () => {
    if (!draftField) return;
    let rule: FilterAnyOfRule | null = null;
    if (draftField === "support_score") {
      if (!draftScores.length) return;
      rule = { field: "support_score", values: [...draftScores].sort() };
    } else if (draftValues.length) {
      rule = { field: draftField, values: [...draftValues] };
    }
    if (!rule) return;
    onChange(addAnyOfRule(filters, rule));
    setDraftValues([]);
    setDraftScores([]);
    setDraftField("");
  };

  const panel = (
    <div
      className={`flex flex-col overflow-hidden bg-white ${
        asDrawer
          ? "h-full max-h-none rounded-none border-0 shadow-none"
          : "card max-h-[calc(100vh-8rem)] p-0"
      }`}
    >
      <div className="shrink-0 space-y-3 border-b border-slate-100 px-4 pb-3 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Filters</h2>
            {matchCount != null ? (
              <p className="mt-0.5 text-xs font-medium text-brand-700">
                {matchCount.toLocaleString()} matching
              </p>
            ) : (
              <p className="mt-0.5 text-[11px] text-slate-500">
                Narrow who appears in charts and lists.
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              onClick={() => onChange(emptyFilters())}
            >
              Clear
            </button>
            {asDrawer && onClose ? (
              <button
                type="button"
                className="btn-ghost px-2 py-1 text-xs"
                onClick={onClose}
              >
                Done
              </button>
            ) : null}
          </div>
        </div>

        <input
          className="input text-sm"
          placeholder="Find a filter…"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          aria-label="Find a filter"
        />

        {activeChips.length > 0 ? (
          <div className="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto">
            {activeChips.map((chip) => (
              <span
                key={chip}
                className="inline-flex max-w-full truncate rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700"
                title={chip}
              >
                {chip}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-slate-400">
            No filters — showing everyone.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {matchSection("tags", "supporter", "maybe", "opposed") ? (
          <FilterSection
            title="Tags"
            hint="Achilles Vote / Maybe / Oppose labels."
            defaultOpen
            forceOpen={Boolean(q)}
            badge={
              filters.supporter_tag?.length
                ? String(filters.supporter_tag.length)
                : null
            }
          >
            <div className="flex flex-wrap gap-1.5">
              {TAG_OPTIONS.map((t) => {
                const on = (filters.supporter_tag ?? []).includes(t.value);
                return (
                  <button
                    key={t.value}
                    type="button"
                    className={`rounded-md px-2.5 py-1.5 text-xs font-semibold capitalize transition ${
                      on
                        ? t.value === "supporter"
                          ? "bg-emerald-600 text-white"
                          : t.value === "opposed"
                            ? "bg-rose-600 text-white"
                            : "bg-amber-500 text-white"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                    onClick={() => setMulti("supporter_tag", t.value)}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </FilterSection>
        ) : null}

        {matchSection("nearby", "distance", "yard", "volunteer", "miles") ? (
          <FilterSection
            title="Nearby"
            hint="Distance range to FormHandler pins. Leave max blank for no upper limit."
            forceOpen={Boolean(q)}
            badge={
              filters.nearby_yard_sign_min_miles != null ||
              filters.nearby_yard_sign_max_miles != null ||
              filters.nearby_yard_sign_miles != null ||
              filters.nearby_volunteer_min_miles != null ||
              filters.nearby_volunteer_max_miles != null ||
              filters.nearby_volunteer_miles != null
                ? "on"
                : null
            }
          >
            <div className="space-y-3">
              <div>
                <p className="mb-1.5 text-xs font-medium text-slate-600">
                  Yard sign distance (mi)
                </p>
                <DistanceRangeInputs
                  minValue={filters.nearby_yard_sign_min_miles}
                  maxValue={
                    filters.nearby_yard_sign_max_miles ??
                    filters.nearby_yard_sign_miles
                  }
                  onMinChange={(miles) =>
                    onChange({
                      ...filters,
                      nearby_yard_sign_min_miles: miles,
                    })
                  }
                  onMaxChange={(miles) =>
                    onChange({
                      ...filters,
                      nearby_yard_sign_max_miles: miles,
                      nearby_yard_sign_miles: null,
                    })
                  }
                />
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium text-slate-600">
                  Volunteer distance (mi)
                </p>
                <DistanceRangeInputs
                  minValue={filters.nearby_volunteer_min_miles}
                  maxValue={
                    filters.nearby_volunteer_max_miles ??
                    filters.nearby_volunteer_miles
                  }
                  onMinChange={(miles) =>
                    onChange({
                      ...filters,
                      nearby_volunteer_min_miles: miles,
                    })
                  }
                  onMaxChange={(miles) =>
                    onChange({
                      ...filters,
                      nearby_volunteer_max_miles: miles,
                      nearby_volunteer_miles: null,
                    })
                  }
                />
              </div>
            </div>
          </FilterSection>
        ) : null}

        {matchSection("petition", "signed", "open", "reproductive", "achilles") ? (
          <FilterSection
            title="Petitions"
            hint="Must have signed each checked petition."
            defaultOpen={!q}
            forceOpen={Boolean(q)}
            badge={filters.signed?.length ? String(filters.signed.length) : null}
          >
            <div className="space-y-1">
              {SIGNED_PETITION_OPTIONS.map((opt) => (
                <label
                  key={opt.key}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={(filters.signed ?? []).includes(opt.key)}
                    onChange={() => toggleSigned(opt.key)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="truncate">{opt.label}</span>
                </label>
              ))}
            </div>
          </FilterSection>
        ) : null}

        {matchSection(
          "geography",
          "county",
          "party",
          "city",
          "zip",
          "status",
          "state",
          "age",
        ) ? (
          <FilterSection
            title="Geography & registration"
            hint="Idaho counties and cities, party, ZIP, status, age."
            forceOpen={Boolean(q)}
            badge={
              [
                filters.state?.length,
                filters.county?.length,
                filters.party?.length,
                filters.city?.length,
                filters.zip?.length,
                filters.status?.length,
                filters.age_min != null || filters.age_max != null ? 1 : 0,
              ].some(Boolean)
                ? "on"
                : null
            }
          >
            <MultiSelect
              label="State"
              values={stateFilterValues(opts.states)}
              selected={filters.state ?? []}
              onToggle={(v) => setMulti("state", v)}
              valueLabels={STATE_VALUE_LABELS}
            />
            <MultiSelect
              label="County (Idaho)"
              values={opts.counties}
              selected={filters.county ?? []}
              onToggle={(v) => setMulti("county", v)}
              searchable
              searchPlaceholder="Search counties…"
              maxHeight="max-h-40"
            />
            <MultiSelect
              label="Party"
              values={opts.parties}
              selected={filters.party ?? []}
              onToggle={(v) => setMulti("party", v)}
            />
            <MultiSelect
              label="City (Idaho)"
              values={opts.cities}
              selected={filters.city ?? []}
              onToggle={(v) => setMulti("city", v)}
              searchable
              searchPlaceholder="Search cities…"
              maxHeight="max-h-40"
            />
            <MultiSelect
              label="Status"
              values={opts.statuses}
              selected={filters.status ?? []}
              onToggle={(v) => setMulti("status", v)}
            />
            <div>
              <label className="label">ZIP (comma-separated)</label>
              <input
                className="input"
                value={(filters.zip ?? []).join(", ")}
                onChange={(e) =>
                  onChange({
                    ...filters,
                    zip: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="e.g. 83702, 83704"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Age min</label>
                <input
                  type="number"
                  className="input"
                  value={filters.age_min ?? ""}
                  onChange={(e) =>
                    onChange({
                      ...filters,
                      age_min:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </div>
              <div>
                <label className="label">Age max</label>
                <input
                  type="number"
                  className="input"
                  value={filters.age_max ?? ""}
                  onChange={(e) =>
                    onChange({
                      ...filters,
                      age_max:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </div>
            </div>
          </FilterSection>
        ) : null}

        {matchSection(
          "campaign",
          "volunteer",
          "yard",
          "donated",
          "alignment",
          "newsletter",
          "event",
          "support",
          "convos",
        ) ? (
          <FilterSection
            title="Campaign attributes"
            hint="Within a field, checked values are OR."
            forceOpen={Boolean(q)}
          >
            <div className="space-y-1">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={filters.has_volunteer === true}
                  onChange={(e) => setFlag("has_volunteer", e.target.checked)}
                  className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                Volunteer interest (Yes)
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={filters.has_yard_sign === true}
                  onChange={(e) => setFlag("has_yard_sign", e.target.checked)}
                  className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                Yard sign (Yes / Delivered)
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={filters.has_donated === true}
                  onChange={(e) => setFlag("has_donated", e.target.checked)}
                  className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                Donated
              </label>
            </div>
            <MultiSelect
              label="Alignment label"
              values={opts.alignment_labels}
              selected={filters.alignment_label ?? []}
              onToggle={(v) => setMulti("alignment_label", v)}
            />
            <MultiSelect
              label="Yard sign"
              values={opts.yard_signs}
              selected={filters.yard_sign ?? []}
              onToggle={(v) => setMulti("yard_sign", v)}
            />
            <MultiSelect
              label="Volunteer interest"
              values={opts.volunteer_interests}
              selected={filters.volunteer_interest ?? []}
              onToggle={(v) => setMulti("volunteer_interest", v)}
            />
            <MultiSelect
              label="Newsletter"
              values={opts.newsletters}
              selected={filters.newsletter ?? []}
              onToggle={(v) => setMulti("newsletter", v)}
            />
            <MultiSelect
              label="Donated"
              values={opts.donated}
              selected={filters.donated ?? []}
              onToggle={(v) => setMulti("donated", v)}
            />
            <MultiSelect
              label="Attended event"
              values={opts.attended_events}
              selected={filters.attended_event ?? []}
              onToggle={(v) => setMulti("attended_event", v)}
            />
            <MultiSelect
              label="Top main topic"
              values={opts.top_main_topics}
              selected={filters.top_main_topic ?? []}
              onToggle={(v) => setMulti("top_main_topic", v)}
            />
            <MultiSelect
              label="Convos — candidate support"
              values={opts.convos_candidate_support}
              selected={filters.convos_candidate_support ?? []}
              onToggle={(v) => setMulti("convos_candidate_support", v)}
            />
            <MultiSelect
              label="Convos — contact status"
              values={opts.convos_contact_status}
              selected={filters.convos_contact_status ?? []}
              onToggle={(v) => setMulti("convos_contact_status", v)}
            />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Support min</label>
                <input
                  type="number"
                  min={1}
                  max={5}
                  className="input"
                  value={filters.support_score_min ?? ""}
                  onChange={(e) =>
                    onChange({
                      ...filters,
                      support_score_min:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </div>
              <div>
                <label className="label">Support max</label>
                <input
                  type="number"
                  min={1}
                  max={5}
                  className="input"
                  value={filters.support_score_max ?? ""}
                  onChange={(e) =>
                    onChange({
                      ...filters,
                      support_score_max:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </div>
            </div>
          </FilterSection>
        ) : null}

        {matchSection("match any", "or", "organizer") ? (
          <FilterSection
            title="Match any (OR)"
            hint="Include if any rule matches — like Organizer communities."
            forceOpen={Boolean(q)}
            badge={anyOf.length ? `${anyOf.length} rules` : null}
          >
            {anyOf.length > 0 ? (
              <ul className="space-y-2">
                {anyOf.map((rule, i) => (
                  <li
                    key={`${rule.field}-${i}`}
                    className="rounded-md border border-teal-200 bg-teal-50/60 px-2.5 py-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs text-slate-700">
                        {i > 0 ? (
                          <span className="mr-1 font-semibold text-teal-800">
                            OR
                          </span>
                        ) : (
                          <span className="mr-1 font-semibold text-teal-800">
                            Where
                          </span>
                        )}
                        {summarizeAnyOfRule(rule)}
                      </p>
                      <button
                        type="button"
                        className="shrink-0 text-xs text-slate-400 hover:text-slate-700"
                        onClick={() => onChange(removeAnyOfRule(filters, i))}
                        aria-label="Remove OR rule"
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-400">No OR rules yet.</p>
            )}

            <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50/80 p-2">
              <label className="block text-xs font-medium text-slate-600">
                Add OR rule
                <select
                  className="input mt-1"
                  value={draftField}
                  onChange={(e) => {
                    setDraftField(
                      (e.target.value || "") as FilterAnyOfField | "",
                    );
                    setDraftValues([]);
                    setDraftScores([]);
                  }}
                >
                  <option value="">Select filter…</option>
                  {ANY_OF_FIELDS.map((f) => (
                    <option key={f.field} value={f.field}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>

              {!draftField ? (
                <p className="text-xs text-slate-400">
                  Choose a field above to pick values.
                </p>
              ) : draftField === "support_score" ? (
                <div className="max-h-36 space-y-1 overflow-y-auto">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <label
                      key={n}
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={draftScores.includes(n)}
                        onChange={() =>
                          setDraftScores((prev) =>
                            prev.includes(n)
                              ? prev.filter((x) => x !== n)
                              : [...prev, n],
                          )
                        }
                        className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      />
                      {n} — {SUPPORT_SCORE_LABELS[n] ?? n}
                    </label>
                  ))}
                </div>
              ) : (
                <div className="max-h-36 space-y-1 overflow-y-auto">
                  {draftOptions.map((v) => (
                    <label
                      key={v}
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={draftValues.includes(v)}
                        onChange={() =>
                          setDraftValues((prev) =>
                            prev.includes(v)
                              ? prev.filter((x) => x !== v)
                              : [...prev, v],
                          )
                        }
                        className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      />
                      <span className="truncate">{v}</span>
                    </label>
                  ))}
                </div>
              )}

              <button
                type="button"
                className="btn-secondary w-full text-xs"
                onClick={addDraftRule}
              >
                Add to OR group
              </button>
            </div>
          </FilterSection>
        ) : null}

        {matchSection("exclude") ? (
          <ExcludeProfilesSection
            filters={filters}
            options={opts}
            onChange={onChange}
          />
        ) : null}
      </div>
    </div>
  );

  if (asDrawer) {
    return (
      <div className="fixed inset-0 z-40 flex justify-end">
        <button
          type="button"
          className="absolute inset-0 bg-slate-900/30"
          aria-label="Close filters"
          onClick={() => onClose?.()}
        />
        <div className="relative z-10 flex h-full w-full max-w-sm flex-col border-l border-slate-200 bg-white shadow-xl">
          {panel}
        </div>
      </div>
    );
  }

  return panel;
}


function MultiSelect({
  label,
  values,
  selected,
  onToggle,
  maxHeight = "max-h-36",
  valueLabels,
  searchable = false,
  searchPlaceholder = "Search…",
}: {
  label: string;
  values: string[];
  selected: string[];
  onToggle: (v: string) => void;
  maxHeight?: string;
  valueLabels?: Record<string, string>;
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return values;
    return values.filter((v) => {
      const label = (valueLabels?.[v] ?? v).toLowerCase();
      return label.includes(needle) || v.toLowerCase().includes(needle);
    });
  }, [values, q, valueLabels]);

  return (
    <div>
      <p className="label">{label}</p>
      {searchable && values.length > 8 ? (
        <input
          className="input mb-1.5 text-sm"
          placeholder={searchPlaceholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={`Search ${label}`}
        />
      ) : null}
      {values.length === 0 ? (
        <p className="text-xs text-slate-400">No values in import.</p>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-slate-400">No matches.</p>
      ) : (
        <div
          className={`${maxHeight} space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2`}
        >
          {filtered.map((v) => (
            <label
              key={v}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <input
                type="checkbox"
                checked={selected.includes(v)}
                onChange={() => onToggle(v)}
                className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="truncate">{valueLabels?.[v] ?? v}</span>
            </label>
          ))}
        </div>
      )}
      {selected.length > 0 ? (
        <p className="mt-1 text-[11px] text-slate-500">
          {selected.length} selected
        </p>
      ) : null}
    </div>
  );
}

function summarizeExcludeRule(
  key: ExcludeAttrKey,
  def: AttrDef | undefined,
  exclude: NonNullable<VoterFilters["exclude"]>,
): string {
  if (key === "age") {
    return `${exclude.age_min ?? "…"}–${exclude.age_max ?? "…"}`;
  }
  if (key === "support_score") {
    return `${exclude.support_score_min ?? "…"}–${exclude.support_score_max ?? "…"}`;
  }
  if (
    key === "has_volunteer" ||
    key === "has_yard_sign" ||
    key === "has_donated" ||
    key === "campaign_volunteer"
  ) {
    return "Yes";
  }
  const vals =
    (exclude[key as keyof typeof exclude] as string[] | undefined) ?? [];
  return vals.map((v) => def?.valueLabels?.[v] ?? v).join(", ");
}

function ExcludeProfilesSection({
  filters,
  options,
  onChange,
}: {
  filters: VoterFilters;
  options: FilterOptions;
  onChange: (next: VoterFilters) => void;
}) {
  const catalog = useMemo(() => buildExcludeCatalog(options), [options]);
  const allAttrs = useMemo(() => flattenAttrs(catalog), [catalog]);
  const attrByKey = useMemo(
    () =>
      Object.fromEntries(allAttrs.map((a) => [a.key, a])) as Record<
        ExcludeAttrKey,
        AttrDef
      >,
    [allAttrs],
  );

  const exclude = filters.exclude ?? {};
  const activeKeys = allAttrs
    .map((a) => a.key)
    .filter((k) => excludeAttrActive(exclude, k));

  const signedOverlap = (filters.signed ?? []).filter((k) =>
    (exclude.signed ?? []).includes(k),
  );

  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draftAttr, setDraftAttr] = useState<ExcludeAttrKey | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    tags: true,
    petitions: true,
    activity: true,
    convos: true,
    geo: false,
  });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setPickerOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [pickerOpen]);

  const q = search.trim().toLowerCase();
  const filteredFlat = q
    ? allAttrs.filter(
        (a) =>
          a.label.toLowerCase().includes(q) || a.key.toLowerCase().includes(q),
      )
    : null;

  const selectAttr = (key: ExcludeAttrKey) => {
    setDraftAttr(key);
    setPickerOpen(false);
    setSearch("");
  };

  const draftDef = draftAttr ? attrByKey[draftAttr] : null;
  const draftSelected =
    draftAttr && draftDef?.kind === "multi"
      ? ((exclude[draftAttr as "signed"] as string[] | undefined) ?? [])
      : [];

  const toggleDraftValue = (value: string) => {
    if (!draftAttr) return;
    if (draftDef?.kind === "flag") {
      const on = !excludeAttrActive(exclude, draftAttr);
      onChange(setExcludeValues(filters, draftAttr, on ? ["yes"] : []));
      return;
    }
    const current =
      (exclude[draftAttr as "county"] as string[] | undefined) ?? [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    onChange(setExcludeValues(filters, draftAttr, next));
  };

  const removeRule = (key: ExcludeAttrKey) => {
    onChange(clearExcludeAttr(filters, key));
    if (draftAttr === key) setDraftAttr(null);
  };

  return (
    <section className="mt-2 space-y-3 border-t border-slate-200 pt-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-800">
          Exclude Profiles
        </h3>
        <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
          Applied after include filters. Example: check three petitions above,
          then exclude Achilles here — keeps people who signed those three
          without Achilles.
        </p>
      </div>

      {signedOverlap.length > 0 && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900">
          Same petition is both included and excluded (
          {signedOverlap
            .map(
              (k) =>
                SIGNED_PETITION_OPTIONS.find((o) => o.key === k)?.label ?? k,
            )
            .join(", ")}
          ). That combination matches nobody for that petition.
        </p>
      )}

      {activeKeys.length > 0 && (
        <ul className="space-y-2">
          {activeKeys.map((key) => {
            const def = attrByKey[key];
            return (
              <li
                key={key}
                className="rounded-md border border-amber-200 bg-amber-50/50 px-2.5 py-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 text-left"
                    onClick={() => setDraftAttr(key)}
                  >
                    <p className="text-xs font-medium text-slate-700">
                      Where{" "}
                      <span className="text-amber-800">
                        {def?.label ?? key}
                      </span>
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-slate-600">
                      {summarizeExcludeRule(key, def, exclude)}
                    </p>
                  </button>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-slate-400 hover:text-slate-700"
                    onClick={() => removeRule(key)}
                    aria-label={`Remove ${def?.label ?? key}`}
                  >
                    ✕
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div ref={rootRef} className="relative space-y-2">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-sm font-medium text-slate-600">
            Where
          </span>
          <div className="relative min-w-0 flex-1">
            <button
              type="button"
              className="input flex w-full items-center justify-between gap-2 text-left"
              onClick={() => setPickerOpen((o) => !o)}
            >
              <span
                className={
                  draftDef ? "truncate text-slate-800" : "text-slate-400"
                }
              >
                {draftDef?.label ?? "Search"}
              </span>
              <svg
                className="h-4 w-4 shrink-0 text-slate-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-4.35-4.35M10.5 18a7.5 7.5 0 100-15 7.5 7.5 0 000 15z"
                />
              </svg>
            </button>

            {pickerOpen && (
              <div className="absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg">
                <div className="border-b border-slate-100 p-2">
                  <input
                    autoFocus
                    className="input py-1.5 text-sm"
                    placeholder="Search attributes…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <div className="max-h-56 overflow-y-auto py-1">
                  {filteredFlat ? (
                    filteredFlat.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-slate-400">
                        No attributes match.
                      </p>
                    ) : (
                      filteredFlat.map((a) => (
                        <button
                          key={a.key}
                          type="button"
                          className="block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50"
                          onClick={() => selectAttr(a.key)}
                        >
                          {a.label}
                        </button>
                      ))
                    )
                  ) : (
                    catalog.map((group) => {
                      const open = expanded[group.id] !== false;
                      return (
                        <div key={group.id}>
                          <button
                            type="button"
                            className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 hover:bg-slate-50"
                            onClick={() =>
                              setExpanded((e) => ({
                                ...e,
                                [group.id]: !open,
                              }))
                            }
                          >
                            <span className="inline-block w-3 text-slate-400">
                              {open ? "▾" : "▸"}
                            </span>
                            {group.label}
                          </button>
                          {open &&
                            group.attrs?.map((a) => (
                              <button
                                key={a.key}
                                type="button"
                                className="block w-full py-1.5 pl-8 pr-3 text-left text-sm text-slate-700 hover:bg-teal-50 hover:text-teal-900"
                                onClick={() => selectAttr(a.key)}
                              >
                                {a.label}
                              </button>
                            ))}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {draftDef && (
          <div className="rounded-md border border-slate-200 bg-slate-50/80 p-2">
            <p className="mb-1.5 text-[11px] font-medium text-slate-600">
              Exclude <span className="text-slate-800">{draftDef.label}</span>
            </p>

            {draftDef.kind === "flag" && (
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={excludeAttrActive(exclude, draftDef.key)}
                  onChange={() => toggleDraftValue("yes")}
                  className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                />
                Exclude people with this activity
              </label>
            )}

            {draftDef.kind === "zip" && (
              <input
                className="input"
                value={(exclude.zip ?? []).join(", ")}
                onChange={(e) =>
                  onChange(
                    setExcludeValues(
                      filters,
                      "zip",
                      e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    ),
                  )
                }
                placeholder="e.g. 83702, 83704"
              />
            )}

            {draftDef.kind === "range" && draftDef.key === "age" && (
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  className="input"
                  placeholder={draftDef.rangeMinHint}
                  value={exclude.age_min ?? ""}
                  onChange={(e) =>
                    onChange(
                      setExcludeRange(
                        filters,
                        "age",
                        e.target.value === "" ? null : Number(e.target.value),
                        exclude.age_max ?? null,
                      ),
                    )
                  }
                />
                <input
                  type="number"
                  className="input"
                  placeholder={draftDef.rangeMaxHint}
                  value={exclude.age_max ?? ""}
                  onChange={(e) =>
                    onChange(
                      setExcludeRange(
                        filters,
                        "age",
                        exclude.age_min ?? null,
                        e.target.value === "" ? null : Number(e.target.value),
                      ),
                    )
                  }
                />
              </div>
            )}

            {draftDef.kind === "range" && draftDef.key === "support_score" && (
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  min={1}
                  max={5}
                  className="input"
                  placeholder={draftDef.rangeMinHint}
                  value={exclude.support_score_min ?? ""}
                  onChange={(e) =>
                    onChange(
                      setExcludeRange(
                        filters,
                        "support_score",
                        e.target.value === "" ? null : Number(e.target.value),
                        exclude.support_score_max ?? null,
                      ),
                    )
                  }
                />
                <input
                  type="number"
                  min={1}
                  max={5}
                  className="input"
                  placeholder={draftDef.rangeMaxHint}
                  value={exclude.support_score_max ?? ""}
                  onChange={(e) =>
                    onChange(
                      setExcludeRange(
                        filters,
                        "support_score",
                        exclude.support_score_min ?? null,
                        e.target.value === "" ? null : Number(e.target.value),
                      ),
                    )
                  }
                />
              </div>
            )}

            {draftDef.kind === "multi" &&
              (draftDef.values?.length ? (
                <div className="max-h-36 space-y-1 overflow-y-auto">
                  {draftDef.values.map((v) => (
                    <label
                      key={v}
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={draftSelected.includes(v)}
                        onChange={() => toggleDraftValue(v)}
                        className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                      />
                      <span className="truncate">
                        {draftDef.valueLabels?.[v] ?? v}
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-400">No values in import.</p>
              ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          className="text-xs font-medium text-slate-500 hover:text-slate-800 disabled:opacity-40"
          disabled={activeKeys.length === 0 && !draftAttr}
          onClick={() => {
            onChange(clearExclude(filters));
            setDraftAttr(null);
          }}
        >
          Clear All Filters
        </button>
        <p className="text-[10px] text-slate-400">
          Excludes apply as you select values
        </p>
      </div>
    </section>
  );
}
