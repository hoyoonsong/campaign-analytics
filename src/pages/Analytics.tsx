import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { PetitionExportModal } from '../components/PetitionExportModal';
import { PetitionVenn } from '../components/PetitionVenn';
import {
  EMPTY_FILTER_OPTIONS,
  mergeOptions,
  VoterFiltersPanel,
} from '../components/VoterFiltersPanel';
import { VoterMap } from '../components/VoterMap';
import { VoterProfileModal } from '../components/VoterProfileModal';
import { logActivity } from '../lib/activityLog';
import {
  fetchAnalytics,
  fetchFilterOptions,
  fetchMapPoints,
} from '../lib/api';
import { downloadVotersCsv, sleep } from '../lib/exportVotersCsv';
import { emptyFilters, summarizeFilters } from '../lib/filters';
import { normalizeCountyName } from '../lib/idahoCounties';
import {
  ageBandToRange,
  navigateToSearch,
} from '../lib/navigateToSearch';
import {
  PETITION_COMBOS,
  comboExportFilename,
  mergeFiltersWithSegment,
  type PetitionVennKey,
} from '../lib/petitionCombos';
import type {
  AnalyticsSummary,
  CountBucket,
  MapPoint,
  SignedPetitionKey,
  VoterFilters,
} from '../lib/types';

const CHART_BLUE = '#1d4ed8';
const CHART_TEAL = '#0f766e';
const CHART_AMBER = '#b45309';
const CHART_SLATE = '#475569';
const AGE_ORDER = ['Under 18', '18–24', '25–34', '35–44', '45–54', '55–64', '65+', 'Unknown'];

const PETITION_SIGNED_KEYS: Record<string, SignedPetitionKey> = {
  'Open Primaries': 'open_primaries',
  'Reproductive Freedom': 'reproductive_freedom',
  'Medical Marijuana (VAL)': 'medical_marijuana_valid',
};

export default function Analytics() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<VoterFilters>(emptyFilters());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [points, setPoints] = useState<MapPoint[]>([]);
  const [campaignGeo, setCampaignGeo] = useState<
    Array<{ kind: 'volunteer' | 'yard_sign'; lat: number; lng: number }>
  >([]);
  const [truncated, setTruncated] = useState(false);
  const [options, setOptions] = useState(EMPTY_FILTER_OPTIONS);
  const [loading, setLoading] = useState(true);
  const [pinsLoading, setPinsLoading] = useState(false);
  const [focusCounty, setFocusCounty] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [exportingKey, setExportingKey] = useState<PetitionVennKey | null>(null);
  const [exportingAll, setExportingAll] = useState(false);

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

  const activeFilterChips = useMemo(() => summarizeFilters(filters), [filters]);

  const sig = summary?.signatures;
  const petitionBars = useMemo(() => {
    const rows = summary?.by_signature ?? [];
    const preferred = [
      'Open Primaries',
      'Reproductive Freedom',
      'Medical Marijuana (VAL)',
    ];
    const byKey = new Map(rows.map((r) => [r.key, r.count]));
    return preferred.map((key) => ({
      name: key,
      signed: byKey.get(key) ?? 0,
      pct: summary?.total ? ((byKey.get(key) ?? 0) / summary.total) * 100 : 0,
    }));
  }, [summary]);

  const goSearch = (patch: Partial<VoterFilters>) => {
    navigateToSearch(navigate, { ...filters, ...patch });
  };

  const exportSegment = async (key: PetitionVennKey) => {
    setExportingKey(key);
    setError(null);
    try {
      const merged = mergeFiltersWithSegment(filters, key);
      const count = await downloadVotersCsv({
        filters: merged,
        filename: comboExportFilename(key),
      });
      void logActivity({
        action: 'export',
        entityType: 'voter',
        metadata: { label: `Petition combo CSV (${key})`, count },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExportingKey(null);
    }
  };

  const exportAllCombos = async () => {
    setExportingAll(true);
    setError(null);
    try {
      let total = 0;
      for (const combo of PETITION_COMBOS) {
        setExportingKey(combo.key);
        const merged = mergeFiltersWithSegment(filters, combo.key);
        const count = await downloadVotersCsv({
          filters: merged,
          filename: comboExportFilename(combo.key),
        });
        total += count;
        await sleep(400);
      }
      void logActivity({
        action: 'export',
        entityType: 'voter',
        metadata: { label: 'Petition combo CSV (all 7)', count: total },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExportingKey(null);
      setExportingAll(false);
    }
  };

  const ageBars = useMemo(
    () => orderBuckets(summary?.by_age ?? [], AGE_ORDER),
    [summary],
  );

  const partyBars = useMemo(
    () => (summary?.by_party ?? []).slice(0, 8).map((r) => ({ name: r.key, count: r.count })),
    [summary],
  );

  const countyBars = useMemo(
    () =>
      (summary?.by_county ?? [])
        .map((r) => ({
          name: normalizeCountyName(r.key) ?? r.key,
          count: r.count,
          idaho: !!normalizeCountyName(r.key),
        }))
        .filter((r) => r.idaho)
        .slice(0, 10),
    [summary],
  );

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
        description="Click a chart or stat to open that list in Search. Map clicks stay on the map."
        actions={
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setFiltersOpen(true)}
          >
            Filters
            {activeFilterChips.length > 0
              ? ` (${activeFilterChips.length})`
              : ''}
          </button>
        }
      />

      {activeFilterChips.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {activeFilterChips.slice(0, 8).map((chip) => (
            <span
              key={chip}
              className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700"
            >
              {chip}
            </span>
          ))}
          {activeFilterChips.length > 8 ? (
            <span className="text-[11px] text-slate-400">
              +{activeFilterChips.length - 8} more
            </span>
          ) : null}
          <button
            type="button"
            className="text-[11px] font-medium text-brand-700 hover:underline"
            onClick={() => setFilters(emptyFilters())}
          >
            Clear
          </button>
        </div>
      ) : null}

      <VoterFiltersPanel
        asDrawer
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        filters={filters}
        onChange={setFilters}
        options={options}
        matchCount={summary?.total ?? null}
      />

      <PetitionExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        counts={summary?.petition_venn}
        exportingKey={exportingKey}
        exportingAll={exportingAll}
        onExportSegment={(key) => void exportSegment(key)}
        onExportAll={() => void exportAllCombos()}
      />

      <div className="space-y-3">
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
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="Matching voters"
                value={summary.total}
                onClick={() => goSearch({})}
              />
              <StatCard
                label="Supporters"
                value={Number(summary.supporters ?? 0)}
                hint={pctOfInterest(
                  Number(summary.supporters ?? 0),
                  interestUniverse,
                )}
                onClick={() => goSearch({ supporter_tag: ['supporter'] })}
              />
              <StatCard
                label="Maybe"
                value={Number(summary.maybes ?? 0)}
                hint={pctOfInterest(
                  Number(summary.maybes ?? 0),
                  interestUniverse,
                )}
                onClick={() => goSearch({ supporter_tag: ['maybe'] })}
              />
              <StatCard
                label="Opposed"
                value={Number(summary.opposed ?? 0)}
                hint={pctOfInterest(
                  Number(summary.opposed ?? 0),
                  interestUniverse,
                )}
                onClick={() => goSearch({ supporter_tag: ['opposed'] })}
              />
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="card flex items-center justify-between gap-3 px-4 py-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Avg mi to yard sign
                  </p>
                  <p className="text-lg font-bold text-slate-900">
                    {summary.avg_nearby_yard_sign_miles != null
                      ? `${Number(summary.avg_nearby_yard_sign_miles).toLocaleString(undefined, { maximumFractionDigits: 2 })} mi`
                      : '—'}
                  </p>
                </div>
              </div>
              <div className="card flex items-center justify-between gap-3 px-4 py-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Avg mi to volunteer
                  </p>
                  <p className="text-lg font-bold text-slate-900">
                    {summary.avg_nearby_volunteer_miles != null
                      ? `${Number(summary.avg_nearby_volunteer_miles).toLocaleString(undefined, { maximumFractionDigits: 2 })} mi`
                      : '—'}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <section className="card p-3">
                <h3 className="mb-1 text-sm font-semibold text-slate-800">
                  Petition signatures
                </h3>
                <p className="mb-2 text-xs text-slate-500">
                  Click a bar to open that petition list in Search.
                </p>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={petitionBars}
                      layout="vertical"
                      margin={{ left: 4, right: 12, top: 4, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                      <XAxis
                        type="number"
                        tickFormatter={(v) => Number(v).toLocaleString()}
                        tick={{ fontSize: 10 }}
                      />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={130}
                        tick={{ fontSize: 10 }}
                      />
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
                      <Bar
                        dataKey="signed"
                        radius={[0, 4, 4, 0]}
                        cursor="pointer"
                        onClick={(data) => {
                          const name = (data as { name?: string })?.name;
                          const key = name ? PETITION_SIGNED_KEYS[name] : null;
                          if (key) goSearch({ signed: [key] });
                        }}
                      >
                        {petitionBars.map((_, i) => (
                          <Cell
                            key={i}
                            fill={[CHART_BLUE, CHART_TEAL, CHART_AMBER][i % 3]}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1.5">
                  <MiniStat
                    label="Open Primaries"
                    value={sig?.open_primaries ?? 0}
                    total={summary.total}
                    onClick={() => goSearch({ signed: ['open_primaries'] })}
                  />
                  <MiniStat
                    label="Repro Freedom"
                    value={sig?.reproductive_freedom ?? 0}
                    total={summary.total}
                    onClick={() =>
                      goSearch({ signed: ['reproductive_freedom'] })
                    }
                  />
                  <MiniStat
                    label="MMJ VAL"
                    value={sig?.medical_marijuana_valid ?? 0}
                    total={summary.total}
                    onClick={() =>
                      goSearch({ signed: ['medical_marijuana_valid'] })
                    }
                  />
                </div>
              </section>

              <section className="card p-3">
                <div className="mb-1 flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-800">
                    Petition combinations
                  </h3>
                  <button
                    type="button"
                    className="btn-primary shrink-0 px-3 py-1.5 text-xs"
                    onClick={() => setExportOpen(true)}
                  >
                    Export
                  </button>
                </div>
                <PetitionVenn
                  compact
                  counts={summary.petition_venn}
                  onSelectSegment={(key) =>
                    navigateToSearch(navigate, mergeFiltersWithSegment(filters, key))
                  }
                />
              </section>
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              <ChartCard
                title="By party"
                subtitle="Click a bar → Search"
                height="h-48"
              >
                <BarChart
                  data={partyBars}
                  layout="vertical"
                  margin={{ left: 4, right: 8, top: 4, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis
                    type="number"
                    tickFormatter={(v) => Number(v).toLocaleString()}
                    tick={{ fontSize: 10 }}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={88}
                    tick={{ fontSize: 10 }}
                  />
                  <Tooltip formatter={(v) => Number(v ?? 0).toLocaleString()} />
                  <Bar
                    dataKey="count"
                    fill={CHART_BLUE}
                    radius={[0, 4, 4, 0]}
                    cursor="pointer"
                    onClick={(data) => {
                      const name = (data as { name?: string; payload?: { name?: string } })
                        ?.payload?.name
                        ?? (data as { name?: string })?.name;
                      if (name) goSearch({ party: [name] });
                    }}
                  />
                </BarChart>
              </ChartCard>

              <ChartCard
                title="By age"
                subtitle="Click a bar → Search"
                height="h-48"
              >
                <BarChart
                  data={ageBars}
                  margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} />
                  <YAxis
                    tickFormatter={(v) => Number(v).toLocaleString()}
                    width={40}
                    tick={{ fontSize: 10 }}
                  />
                  <Tooltip formatter={(v) => Number(v ?? 0).toLocaleString()} />
                  <Bar
                    dataKey="count"
                    fill={CHART_AMBER}
                    radius={[4, 4, 0, 0]}
                    cursor="pointer"
                    onClick={(data) => {
                      const name = (data as { name?: string; payload?: { name?: string } })
                        ?.payload?.name
                        ?? (data as { name?: string })?.name;
                      if (!name) return;
                      const range = ageBandToRange(name);
                      if (range) goSearch(range);
                    }}
                  />
                </BarChart>
              </ChartCard>

              <ChartCard
                title="Top counties"
                subtitle="Click → Search · map zooms separately"
                height="h-48"
              >
                <BarChart
                  data={countyBars}
                  layout="vertical"
                  margin={{ left: 4, right: 8, top: 4, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis
                    type="number"
                    tickFormatter={(v) => Number(v).toLocaleString()}
                    tick={{ fontSize: 10 }}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={72}
                    tick={{ fontSize: 10 }}
                  />
                  <Tooltip formatter={(v) => Number(v ?? 0).toLocaleString()} />
                  <Bar
                    dataKey="count"
                    radius={[0, 4, 4, 0]}
                    cursor="pointer"
                    onClick={(data) => {
                      const name = (data as { name?: string; payload?: { name?: string } })
                        ?.payload?.name
                        ?? (data as { name?: string })?.name;
                      if (name) goSearch({ county: [name] });
                    }}
                  >
                    {countyBars.map((row) => (
                      <Cell key={row.name} fill={CHART_SLATE} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartCard>
            </div>

            <section className="space-y-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-800">Map</h3>
                <p className="text-xs text-slate-500">
                  Click a county to zoom and show pins. Chart clicks open Search —
                  map stays here.
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
  return `${((100 * part) / total).toFixed(1)}%`;
}

function pctOfInterest(part: number, taggedTotal: number) {
  if (!taggedTotal) return '0% of tagged';
  return `${((100 * part) / taggedTotal).toFixed(1)}% of tagged`;
}

function StatCard({
  label,
  value,
  hint,
  onClick,
}: {
  label: string;
  value: number | null;
  hint?: string;
  onClick?: () => void;
}) {
  const display = value == null ? '—' : value.toLocaleString();
  const className = `card p-3 text-left ${onClick ? 'cursor-pointer transition hover:border-brand-300 hover:bg-brand-50/40' : ''}`;
  const body = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-0.5 text-xl font-bold text-slate-900">{display}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p> : null}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick}>
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}

function MiniStat({
  label,
  value,
  total,
  onClick,
}: {
  label: string;
  value: number;
  total: number;
  onClick?: () => void;
}) {
  const className = `rounded-md bg-slate-50 px-2 py-1.5 text-left ${onClick ? 'cursor-pointer hover:bg-slate-100' : ''}`;
  const body = (
    <>
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className="text-xs font-semibold text-slate-900">
        {value.toLocaleString()}{' '}
        <span className="font-normal text-slate-500">({pct(value, total)})</span>
      </p>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick}>
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}

function ChartCard({
  title,
  subtitle,
  children,
  height = 'h-48',
}: {
  title: string;
  subtitle?: string;
  children: ReactElement;
  height?: string;
}) {
  return (
    <div className="card p-3">
      <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
      {subtitle ? (
        <p className="mb-2 text-[11px] text-slate-500">{subtitle}</p>
      ) : (
        <div className="mb-2" />
      )}
      <div className={height}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
