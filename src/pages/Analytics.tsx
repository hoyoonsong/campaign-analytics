import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Alert, EmptyState, PageHeader, Spinner } from '../components/ui';
import {
  EMPTY_FILTER_OPTIONS,
  mergeOptions,
  VoterFiltersPanel,
} from '../components/VoterFiltersPanel';
import { VoterMap } from '../components/VoterMap';
import { VoterProfileModal } from '../components/VoterProfileModal';
import {
  fetchAnalytics,
  fetchFilterOptions,
  fetchMapPoints,
} from '../lib/api';
import { emptyFilters } from '../lib/filters';
import { normalizeCountyName } from '../lib/idahoCounties';
import type { AnalyticsSummary, CountBucket, MapPoint, VoterFilters } from '../lib/types';

const CHART_BLUE = '#1d4ed8';
const CHART_TEAL = '#0f766e';
const CHART_AMBER = '#b45309';
const CHART_SLATE = '#475569';
const AGE_ORDER = ['Under 18', '18–24', '25–34', '35–44', '45–54', '55–64', '65+', 'Unknown'];

export default function Analytics() {
  const [filters, setFilters] = useState<VoterFilters>(emptyFilters());
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [points, setPoints] = useState<MapPoint[]>([]);
  const [campaignGeo, setCampaignGeo] = useState<
    Array<{ kind: 'volunteer' | 'yard_sign'; lat: number; lng: number }>
  >([]);
  const [truncated, setTruncated] = useState(false);
  const [options, setOptions] = useState(EMPTY_FILTER_OPTIONS);
  const [loading, setLoading] = useState(true);
  const [pinsLoading, setPinsLoading] = useState(false);
  /** County zoomed on the map with pins (not a filter). */
  const [focusCounty, setFocusCounty] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<number | null>(null);

  useEffect(() => {
    void fetchFilterOptions()
      .then((o) => setOptions(mergeOptions(o)))
      .catch(() => setOptions(EMPTY_FILTER_OPTIONS));
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const t = setTimeout(() => {
      void fetchAnalytics(filters)
        .then((data) => {
          if (active) setSummary(data);
        })
        .catch((err: Error) => {
          if (active) setError(err.message);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [filters]);

  // Pins only for the focused map county — never statewide.
  // Clear immediately on county change so prior pins never linger.
  useEffect(() => {
    setPoints([]);
    setCampaignGeo([]);
    setTruncated(false);
    if (!focusCounty) return;

    let active = true;
    setPinsLoading(true);
    const t = setTimeout(() => {
      void fetchMapPoints(
        { ...emptyFilters(), county: [focusCounty] },
        8000,
      )
        .then((data) => {
          if (!active) return;
          setPoints(data.points ?? []);
          setTruncated(!!data.truncated);
          setCampaignGeo(data.campaign_geo ?? []);
        })
        .catch((err: Error) => {
          if (active) setError(err.message);
        })
        .finally(() => {
          if (active) setPinsLoading(false);
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [focusCounty]);

  const countyCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const bucket of summary?.by_county ?? []) {
      const name = normalizeCountyName(bucket.key);
      if (!name) continue;
      map[name] = (map[name] ?? 0) + bucket.count;
    }
    return map;
  }, [summary]);

  const interestUniverse =
    Number(summary?.supporters ?? 0) +
    Number(summary?.maybes ?? 0) +
    Number(summary?.opposed ?? 0);


  const sig = summary?.signatures;
  const petitionBars = useMemo(() => {
    const rows = summary?.by_signature ?? [];
    const preferred = [
      'Open Primaries',
      'Reproductive Freedom',
      'Achilles Petition',
      'Medical Marijuana (VAL)',
    ];
    const byKey = new Map(rows.map((r) => [r.key, r.count]));
    return preferred.map((key) => ({
      name: key,
      signed: byKey.get(key) ?? 0,
      pct: summary?.total ? ((byKey.get(key) ?? 0) / summary.total) * 100 : 0,
    }));
  }, [summary]);

  const petitionCountBars = useMemo(() => {
    const rows = summary?.by_petition_count ?? [];
    const byKey = new Map(rows.map((r) => [r.key, r.count]));
    return ['0', '1', '2', '3', '4'].map((key) => ({
      name: key === '1' ? '1 mark' : `${key} marks`,
      count: byKey.get(key) ?? 0,
    }));
  }, [summary]);

  const ageBars = useMemo(
    () => orderBuckets(summary?.by_age ?? [], AGE_ORDER),
    [summary],
  );

  const partyBars = useMemo(
    () => (summary?.by_party ?? []).slice(0, 10).map((r) => ({ name: r.key, count: r.count })),
    [summary],
  );

  const countyBars = useMemo(
    () =>
      (summary?.by_county ?? []).slice(0, 12).map((r) => ({
        name: normalizeCountyName(r.key) ?? r.key,
        count: r.count,
      })),
    [summary],
  );

  const toggleCountyFilter = (name: string) => {
    setFilters((prev) => {
      const current = prev.county ?? [];
      const next = current.includes(name)
        ? current.filter((c) => c !== name)
        : [...current, name].sort((a, b) => a.localeCompare(b));
      return { ...prev, county: next };
    });
  };

  const openCountyPins = (name: string) => {
    setPoints([]);
    setCampaignGeo([]);
    setFocusCounty(name);
  };

  const clearMapFocus = () => {
    setFocusCounty(null);
    setPoints([]);
    setCampaignGeo([]);
    setTruncated(false);
  };

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Supporter mix, presence distance, demographics, and geography. Filters apply to every chart."
      />

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <VoterFiltersPanel
          filters={filters}
          onChange={setFilters}
          options={options}
          matchCount={summary?.total ?? null}
        />

        <div className="space-y-4">
          {error && <Alert variant="error">{error}</Alert>}

          {loading && !summary ? (
            <Spinner label="Loading analytics…" />
          ) : error && !summary ? (
            <EmptyState
              title="Could not load analytics"
              description="Check that `npm run dev` is running and refresh."
            />
          ) : !summary || summary.total === 0 ? (
            <EmptyState
              title="No voters yet"
              description="Import your PDI / signatures export to see petition totals and charts."
            />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard label="Matching voters" value={summary.total} />
                <StatCard
                  label="Supporters"
                  value={Number(summary.supporters ?? 0)}
                  hint={pctOfInterest(
                    Number(summary.supporters ?? 0),
                    interestUniverse,
                  )}
                />
                <StatCard
                  label="Maybe"
                  value={Number(summary.maybes ?? 0)}
                  hint={pctOfInterest(
                    Number(summary.maybes ?? 0),
                    interestUniverse,
                  )}
                />
                <StatCard
                  label="Opposed"
                  value={Number(summary.opposed ?? 0)}
                  hint={pctOfInterest(
                    Number(summary.opposed ?? 0),
                    interestUniverse,
                  )}
                />
              </div>

              <section className="card p-4">
                <h3 className="mb-1 text-sm font-semibold text-slate-800">
                  Presence distance
                </h3>
                <p className="mb-4 text-xs text-slate-500">
                  Cached Idaho averages (nearest FormHandler yard-sign / volunteer).
                  Recalculated when you sync campaign data from Import — not on every
                  page load.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <StatCard
                    label="Avg mi to yard sign"
                    value={
                      summary.avg_nearby_yard_sign_miles != null
                        ? Number(summary.avg_nearby_yard_sign_miles)
                        : null
                    }
                    format="miles"
                    hint={
                      summary.avg_nearby_computed_at
                        ? `Idaho · updated ${new Date(summary.avg_nearby_computed_at).toLocaleString()}`
                        : summary.avg_nearby_sample_size
                          ? `Idaho · sample ~${Number(summary.avg_nearby_sample_size).toLocaleString()}`
                          : 'Sync campaign data to compute'
                    }
                  />
                  <StatCard
                    label="Avg mi to volunteer"
                    value={
                      summary.avg_nearby_volunteer_miles != null
                        ? Number(summary.avg_nearby_volunteer_miles)
                        : null
                    }
                    format="miles"
                    hint={
                      summary.avg_nearby_computed_at
                        ? `Idaho · updated ${new Date(summary.avg_nearby_computed_at).toLocaleString()}`
                        : summary.avg_nearby_sample_size
                          ? `Idaho · sample ~${Number(summary.avg_nearby_sample_size).toLocaleString()}`
                          : 'Sync campaign data to compute'
                    }
                  />
                </div>
              </section>

              <section className="card p-4">
                <h3 className="mb-1 text-sm font-semibold text-slate-800">
                  Petition signatures
                </h3>
                <p className="mb-4 text-xs text-slate-500">
                  Reproductive Freedom combines the True/Yes flag and PDI VAL code. Medical
                  Marijuana is VAL-only.
                </p>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={petitionBars} layout="vertical" margin={{ left: 8, right: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" tickFormatter={(v) => Number(v).toLocaleString()} />
                      <YAxis type="category" dataKey="name" width={160} tick={{ fontSize: 11 }} />
                      <Tooltip
                        formatter={(value, _n, item) => {
                          const v = Number(value ?? 0);
                          const p = item?.payload?.pct as number | undefined;
                          return [
                            `${v.toLocaleString()}${p != null ? ` (${p.toFixed(1)}%)` : ''}`,
                            'Signed',
                          ];
                        }}
                      />
                      <Bar dataKey="signed" radius={[0, 4, 4, 0]}>
                        {petitionBars.map((_, i) => (
                          <Cell
                            key={i}
                            fill={[CHART_BLUE, CHART_TEAL, CHART_AMBER, '#7c3aed'][i % 4]}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <MiniStat
                    label="Open Primaries"
                    value={sig?.open_primaries ?? 0}
                    total={summary.total}
                  />
                  <MiniStat
                    label="Reproductive Freedom"
                    value={sig?.reproductive_freedom ?? 0}
                    total={summary.total}
                    hint="True or VAL"
                  />
                  <MiniStat
                    label="Achilles Petition"
                    value={sig?.achilles_petition ?? 0}
                    total={summary.total}
                  />
                  <MiniStat
                    label="Medical Marijuana (VAL)"
                    value={sig?.medical_marijuana_valid ?? 0}
                    total={summary.total}
                  />
                </div>
              </section>

              <div className="grid gap-4 lg:grid-cols-2">
                <ChartCard
                  title="How many signature marks"
                  subtitle="Per voter — OP, RF (merged), Achilles, MMJ VAL (0–4)"
                >
                  <BarChart data={petitionCountBars} margin={{ left: 0, right: 8, top: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} />
                    <YAxis tickFormatter={(v) => Number(v).toLocaleString()} width={48} />
                    <Tooltip formatter={(v) => Number(v ?? 0).toLocaleString()} />
                    <Bar dataKey="count" fill={CHART_TEAL} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ChartCard>

                <ChartCard title="By party" subtitle="Top parties in the filtered set">
                  <BarChart data={partyBars} layout="vertical" margin={{ left: 8, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tickFormatter={(v) => Number(v).toLocaleString()} />
                    <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => Number(v ?? 0).toLocaleString()} />
                    <Bar dataKey="count" fill={CHART_BLUE} radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ChartCard>

                <ChartCard title="By age" subtitle="Age bands">
                  <BarChart data={ageBars} margin={{ left: 0, right: 8, top: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={(v) => Number(v).toLocaleString()} width={48} />
                    <Tooltip formatter={(v) => Number(v ?? 0).toLocaleString()} />
                    <Bar dataKey="count" fill={CHART_AMBER} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ChartCard>

                <ChartCard
                  title="Top counties"
                  subtitle="Click a county to filter charts · map click shows that county’s pins"
                >
                  <BarChart data={countyBars} layout="vertical" margin={{ left: 8, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tickFormatter={(v) => Number(v).toLocaleString()} />
                    <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => Number(v ?? 0).toLocaleString()} />
                    <Bar
                      dataKey="count"
                      radius={[0, 4, 4, 0]}
                      cursor="pointer"
                      onClick={(data) => {
                        const payload = data as {
                          name?: string;
                          payload?: { name?: string };
                        };
                        const name = payload?.payload?.name ?? payload?.name;
                        if (name) toggleCountyFilter(name);
                      }}
                    >
                      {countyBars.map((row) => {
                        const selected = (filters.county ?? []).includes(row.name);
                        return (
                          <Cell
                            key={row.name}
                            fill={selected ? CHART_BLUE : CHART_SLATE}
                          />
                        );
                      })}
                    </Bar>
                  </BarChart>
                </ChartCard>
              </div>

              <section className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-800">Map</h3>
                  <p className="text-xs text-slate-500">
                    County shading for the filtered set. Click a county to zoom —
                    outline only, with that county’s pins. Use Top counties above to
                    filter charts.
                  </p>
                </div>
                {pinsLoading && focusCounty && (
                  <p className="text-xs text-slate-500">
                    Loading pins for {focusCounty}…
                  </p>
                )}
                <VoterMap
                  countyCounts={countyCounts}
                  focusCounty={focusCounty}
                  onCountyClick={openCountyPins}
                  onClearFocus={clearMapFocus}
                  onOpenProfile={setProfileId}
                  points={points}
                  campaignGeo={campaignGeo}
                  truncated={truncated}
                  totalVoters={summary.total}
                />
              </section>
            </>
          )}
        </div>
      </div>

      {profileId != null && (
        <VoterProfileModal
          voterId={profileId}
          onClose={() => setProfileId(null)}
        />
      )}
    </div>
  );
}

function orderBuckets(rows: CountBucket[], order: string[]) {
  const byKey = new Map(rows.map((r) => [r.key, r.count]));
  return order
    .filter((k) => byKey.has(k))
    .map((name) => ({ name, count: byKey.get(name) ?? 0 }));
}

function pct(part: number, total: number) {
  if (!total) return '0%';
  return `${((100 * part) / total).toFixed(1)}% of matching`;
}

/** Share of people with support / volunteer-interest signals (tagged set). */
function pctOfInterest(part: number, taggedTotal: number) {
  if (!taggedTotal) return '0% of support/interest contacts';
  return `${((100 * part) / taggedTotal).toFixed(1)}% of support/interest contacts`;
}

function StatCard({
  label,
  value,
  hint,
  format = 'count',
}: {
  label: string;
  value: number | null;
  hint?: string;
  format?: 'count' | 'miles';
}) {
  const display =
    value == null
      ? '—'
      : format === 'miles'
        ? `${value.toLocaleString(undefined, {
            maximumFractionDigits: 2,
            minimumFractionDigits: 0,
          })} mi`
        : value.toLocaleString();
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold text-slate-900">{display}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function MiniStat({
  label,
  value,
  total,
  hint,
}: {
  label: string;
  value: number;
  total: number;
  hint?: string;
}) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <p className="text-xs text-slate-500">
        {label}
        {hint ? <span className="text-slate-400"> · {hint}</span> : null}
      </p>
      <p className="text-sm font-semibold text-slate-900">
        {value.toLocaleString()}{' '}
        <span className="font-normal text-slate-500">({pct(value, total)})</span>
      </p>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactElement;
}) {
  return (
    <div className="card p-4">
      <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
      {subtitle ? <p className="mb-3 text-xs text-slate-500">{subtitle}</p> : <div className="mb-3" />}
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
