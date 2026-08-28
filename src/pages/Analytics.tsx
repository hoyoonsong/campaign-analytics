import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Alert, EmptyState, PageHeader, Spinner } from "../components/ui";
import { PetitionCombinations } from "../components/PetitionCombinations";
import { PetitionExportModal } from "../components/PetitionExportModal";
import { PetitionPicker } from "../components/PetitionPicker";
import { PetitionSignatureBars } from "../components/PetitionSignatureBars";
import {
  EMPTY_FILTER_OPTIONS,
  mergeOptions,
  VoterFiltersPanel,
} from "../components/VoterFiltersPanel";
import { VoterMap } from "../components/VoterMap";
import { VoterProfileModal } from "../components/VoterProfileModal";
import { logActivity } from "../lib/activityLog";
import {
  clearClientDataCaches,
  fetchAnalytics,
  fetchFilterOptions,
  fetchMapCampaignGeo,
  fetchMapPoints,
  syncCampaignIndexes,
} from "../lib/api";
import { loadCountyMapCoords } from "../lib/mapCoordsCache";
import { downloadVotersCsv, MAX_EXPORT_ROWS, sleep } from "../lib/exportVotersCsv";
import { emptyFilters, summarizeFilters } from "../lib/filters";
import { normalizeCountyName } from "../lib/idahoCounties";
import { ageBandToRange, navigateToSearch } from "../lib/navigateToSearch";
import {
  bitCount,
  buildPetitionUnits,
  collapseCombosToUnits,
  comboExportFilename,
  filtersForSignedAny,
  mergeFiltersWithCombo,
  mergeFiltersWithUnitCombo,
  sliceSummaryToPetitions,
  superSignerFilters,
  petitionsFromAnalyticsSummary,
  setPetitionLabelCache,
  usePetitions,
  useSelectedPetitions,
} from "../lib/petitions";
import type {
  AnalyticsSummary,
  CampaignSyncState,
  CountBucket,
  VoterFilters,
} from "../lib/types";
import type { CountyCoordPayload } from "../lib/mapCoordsCache";

const CHART_BLUE = "#1d4ed8";
const CHART_AMBER = "#b45309";
const CHART_SLATE = "#475569";
const AGE_ORDER = [
  "Under 18",
  "18–24",
  "25–34",
  "35–44",
  "45–54",
  "55–64",
  "65+",
  "Unknown",
];

export default function Analytics() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<VoterFilters>(emptyFilters());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [coords, setCoords] = useState<CountyCoordPayload | null>(null);
  const [campaignGeo, setCampaignGeo] = useState<
    Array<{
      kind: "volunteer" | "yard_sign";
      lat: number;
      lng: number;
      source_id?: string;
      name?: string | null;
      email?: string | null;
      phone?: string | null;
      address?: string | null;
    }>
  >([]);
  const [truncated, setTruncated] = useState(false);
  const [options, setOptions] = useState(EMPTY_FILTER_OPTIONS);
  const [loading, setLoading] = useState(true);
  const [pinsLoading, setPinsLoading] = useState(false);
  const [focusCounty, setFocusCounty] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [exportingKey, setExportingKey] = useState<string | number | null>(
    null,
  );
  const [exportingAll, setExportingAll] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncState, setSyncState] = useState<CampaignSyncState | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const { activePetitions, groups: petitionGroups } = usePetitions();
  const fallbackPetitions = useMemo(
    () => petitionsFromAnalyticsSummary(summary),
    [summary],
  );
  const allPetitions = activePetitions.length
    ? activePetitions
    : fallbackPetitions;
  const {
    slugs: selectedSlugs,
    selected: selectedPetitions,
    setSelectedSlugs,
    selectAll,
    selectDefaults,
  } = useSelectedPetitions(allPetitions);

  useEffect(() => {
    if (activePetitions.length || !fallbackPetitions.length) return;
    setPetitionLabelCache(fallbackPetitions);
    try {
      const raw = JSON.stringify({
        at: Date.now(),
        data: { petitions: fallbackPetitions, groups: [] },
      });
      sessionStorage.setItem("voter_petitions_v1", raw);
      localStorage.setItem("voter_petitions_v1", raw);
    } catch {
      /* ignore */
    }
  }, [activePetitions.length, fallbackPetitions]);

  const runCampaignSync = async (opts?: {
    recomputeTags?: boolean;
    quiet?: boolean;
  }) => {
    setSyncing(true);
    if (!opts?.quiet) setSyncNote(null);
    try {
      const res = await syncCampaignIndexes({
        recompute_tags: opts?.recomputeTags !== false,
      });
      setSyncState(res.state);
      const yard = res.state?.avg_nearby_yard_sign_miles;
      const vol = res.state?.avg_nearby_volunteer_miles;
      setSyncNote(
        `Synced ${res.state?.volunteer_count ?? 0} volunteers, ${res.state?.yard_sign_count ?? 0} yard signs` +
          (yard != null || vol != null
            ? ` · avg ${yard != null ? Number(yard).toFixed(2) : "—"} mi YS / ${vol != null ? Number(vol).toFixed(2) : "—"} mi V`
            : ""),
      );
      clearClientDataCaches();
      setReloadToken((n) => n + 1);
      return res.state;
    } catch (err) {
      if (!opts?.quiet) {
        setError(err instanceof Error ? err.message : "Campaign sync failed");
      }
      return null;
    } finally {
      setSyncing(false);
    }
  };

  // Do not auto-sync on Analytics load. That GET raced the summary and
  // kept a recovering origin in 522. Sync from Import when you need it.


  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const t = setTimeout(() => {
      void fetchAnalytics(filters)
        .then((data) => {
          if (!active) return;
          setSummary(data);
          setError(null);
        })
        .catch((err: Error) => {
          if (active) setError(err.message);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [filters, reloadToken]);

  useEffect(() => {
    if (!summary) return;
    void fetchFilterOptions()
      .then((o) => setOptions(mergeOptions(o)))
      .catch(() => setOptions(EMPTY_FILTER_OPTIONS));
  }, [summary]);

  useEffect(() => {
    setCoords(null);
    setCampaignGeo([]);
    setTruncated(false);
    setMapError(null);
    if (!focusCounty) return;

    let active = true;
    setPinsLoading(true);
    const t = setTimeout(() => {
      void fetchMapCampaignGeo()
        .then((geo) => {
          if (active) setCampaignGeo(geo.campaign_geo ?? []);
        })
        .catch(() => {
          /* voter snapshot may still succeed */
        });

      void (async () => {
        try {
          const packed = await loadCountyMapCoords(focusCounty);
          if (!active) return;
          setCoords(packed);
          setTruncated(false);
        } catch (err) {
          try {
            const data = await fetchMapPoints(
              { ...emptyFilters(), county: [focusCounty] },
              2500,
            );
            if (!active) return;
            const pts = data.points ?? [];
            setCoords({
              version: 0,
              ids: pts.map((p) => p.id),
              lat: pts.map((p) => p.lat),
              lng: pts.map((p) => p.lng),
            });
            setTruncated(!!data.truncated || pts.length >= 2500);
            if (data.campaign_geo?.length) {
              setCampaignGeo(data.campaign_geo);
            }
            const msg = err instanceof Error ? err.message : "";
            if (!/not installed|0053|schema cache/i.test(msg)) {
              setMapError(
                msg || "Could not load the full county map; showing a sample.",
              );
            }
          } catch (fallbackErr: unknown) {
            if (active) {
              setMapError(
                fallbackErr instanceof Error
                  ? fallbackErr.message
                  : err instanceof Error
                    ? err.message
                    : "Map failed",
              );
            }
          }
        } finally {
          if (active) setPinsLoading(false);
        }
      })();
    }, 150);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [focusCounty, reloadToken]);

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

  const chartSummary = useMemo(
    () =>
      summary ? sliceSummaryToPetitions(summary, selectedPetitions) : null,
    [summary, selectedPetitions],
  );

  const petitionUnits = useMemo(
    () => buildPetitionUnits(selectedPetitions, petitionGroups),
    [selectedPetitions, petitionGroups],
  );

  const petitionCountsBySlug = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of chartSummary?.by_signature ?? []) {
      if (r.slug) map.set(r.slug, r.count);
    }
    return map;
  }, [chartSummary]);

  const unitSuperSigners = useMemo(() => {
    return collapseCombosToUnits(chartSummary?.petition_combos, petitionUnits)
      .filter((c) => bitCount(c.mask) >= 2)
      .reduce((s, c) => s + (Number(c.count) || 0), 0);
  }, [chartSummary, petitionUnits]);

  const goSearch = (patch: Partial<VoterFilters>, find?: string) => {
    navigateToSearch(navigate, { ...filters, ...patch }, { find });
  };

  const goSearchPetition = (slugs: string[], find = "petition") => {
    const { signed: _s, signed_min: _m, signed_min_of: _o, ...rest } = filters;
    navigateToSearch(navigate, { ...rest, ...filtersForSignedAny(slugs) }, {
      find,
    });
  };

  const exportSignedAny = async (
    slugs: string[],
    filename: string,
    key: string,
  ) => {
    setExportingKey(key);
    setError(null);
    try {
      const {
        signed: _s,
        signed_min: _m,
        signed_min_of: _o,
        ...rest
      } = filters;
      const { count } = await downloadVotersCsv({
        filters: { ...rest, ...filtersForSignedAny(slugs) },
        filename,
      });
      void logActivity({
        action: "export",
        entityType: "voter",
        metadata: { label: filename, count },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExportingKey(null);
    }
  };

  const exportSegment = async (mask: number) => {
    setExportingKey(mask);
    setError(null);
    try {
      const merged = mergeFiltersWithCombo(filters, mask, selectedPetitions);
      const { count } = await downloadVotersCsv({
        filters: merged,
        filename: comboExportFilename(mask, selectedPetitions),
      });
      void logActivity({
        action: "export",
        entityType: "voter",
        metadata: { label: `Petition combo CSV (${mask})`, count },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExportingKey(null);
    }
  };

  const exportAllCombos = async () => {
    const rows = [...(chartSummary?.petition_combos ?? [])]
      .map((c) => ({ mask: Number(c.mask), count: Number(c.count) || 0 }))
      .filter((c) => c.count > 0 && c.mask !== 0);
    const rowTotal = rows.reduce((s, c) => s + c.count, 0);
    if (rows.length === 0) return;
    const ok = window.confirm(
      `This will download ${rows.length} CSV files (~${rowTotal.toLocaleString()} rows, each file capped at ${MAX_EXPORT_ROWS.toLocaleString()}).\n\nThat many sequential exports can slow the voter database. Continue?`,
    );
    if (!ok) return;
    setExportingAll(true);
    setError(null);
    try {
      let total = 0;
      for (const combo of rows) {
        setExportingKey(combo.mask);
        const merged = mergeFiltersWithCombo(
          filters,
          combo.mask,
          selectedPetitions,
        );
        const { count } = await downloadVotersCsv({
          filters: merged,
          filename: comboExportFilename(combo.mask, selectedPetitions),
        });
        total += count;
        await sleep(800);
      }
      void logActivity({
        action: "export",
        entityType: "voter",
        metadata: {
          label: `Petition combo CSV (all ${rows.length})`,
          count: total,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
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
    () =>
      (summary?.by_party ?? [])
        .slice(0, 8)
        .map((r) => ({ name: r.key, count: r.count })),
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
    setCoords(null);
    setCampaignGeo([]);
    setTruncated(false);
    setFocusCounty(name);
  };

  const clearMapFocus = () => {
    setFocusCounty(null);
    setCoords(null);
    setCampaignGeo([]);
    setTruncated(false);
  };

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Click a chart or stat to open that list in Search (Filters opens so you can search county and city names). Map clicks stay on the map."
        actions={
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={syncing}
              onClick={() => void runCampaignSync({ recomputeTags: true })}
              title={
                syncState?.updated_at
                  ? `Last sync ${new Date(syncState.updated_at).toLocaleString()}`
                  : "Sync FormHandler volunteers & yard signs"
              }
            >
              {syncing ? "Syncing…" : "Sync FormHandler"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setFiltersOpen(true)}
            >
              Filters
              {activeFilterChips.length > 0
                ? ` (${activeFilterChips.length})`
                : ""}
            </button>
          </div>
        }
      />

      {syncNote ? (
        <p className="mb-3 text-xs text-slate-500">{syncNote}</p>
      ) : null}
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
        showPossibleDuplicates={false}
      />

      <PetitionExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        units={petitionUnits}
        petitions={selectedPetitions}
        combos={chartSummary?.petition_combos}
        exportingKey={exportingKey}
        exportingAll={exportingAll}
        onExportUnit={(unit) =>
          void exportSignedAny(
            unit.petitions.map((p) => p.slug),
            `petition-${unit.short_label.replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv`,
            unit.key,
          )
        }
        onExportPetition={(p) =>
          void exportSignedAny(
            [p.slug],
            `petition-${p.slug}-${new Date().toISOString().slice(0, 10)}.csv`,
            `p:${p.slug}`,
          )
        }
        onExportSegment={(mask) => void exportSegment(mask)}
        onExportAll={() => void exportAllCombos()}
      />

      <div className="space-y-3">
        {error && <Alert variant="error">{error}</Alert>}
        {loading && summary ? (
          <p className="text-xs text-slate-500">Updating analytics…</p>
        ) : null}

        {loading && !summary ? (
          <Spinner label="Loading analytics…" />
        ) : error && !summary ? (
          <EmptyState
            title="Could not load analytics"
            description="The voter database is unreachable (Supabase 522). Wait a minute and refresh. This is not a local crash."
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
                onClick={() => goSearch({}, "tags")}
              />
              <StatCard
                label="Supporters"
                value={Number(summary.supporters ?? 0)}
                hint={pctOfInterest(
                  Number(summary.supporters ?? 0),
                  interestUniverse,
                )}
                onClick={() => goSearch({ supporter_tag: ["supporter"] }, "supporter")}
              />
              <StatCard
                label="Maybe"
                value={Number(summary.maybes ?? 0)}
                hint={pctOfInterest(
                  Number(summary.maybes ?? 0),
                  interestUniverse,
                )}
                onClick={() => goSearch({ supporter_tag: ["maybe"] }, "maybe")}
              />
              <StatCard
                label="Opposed"
                value={Number(summary.opposed ?? 0)}
                hint={pctOfInterest(
                  Number(summary.opposed ?? 0),
                  interestUniverse,
                )}
                onClick={() => goSearch({ supporter_tag: ["opposed"] }, "opposed")}
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
                      : "—"}
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
                      : "—"}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <section className="card p-3">
                <div className="mb-1 flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-800">
                    Petition Totals
                  </h3>
                  <PetitionPicker
                    all={allPetitions}
                    groups={petitionGroups}
                    selectedSlugs={selectedSlugs}
                    onChange={setSelectedSlugs}
                    onSelectAll={selectAll}
                    onSelectDefaults={selectDefaults}
                  />
                </div>

                <PetitionSignatureBars
                  units={petitionUnits}
                  combos={chartSummary?.petition_combos}
                  countsBySlug={petitionCountsBySlug}
                  totalVoters={summary.total}
                  onSelectSlugs={(slugs) => goSearchPetition(slugs)}
                />
              </section>

              <section className="card p-3">
                <div className="mb-1 flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-800">
                    Petition combinations
                  </h3>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {petitionUnits.length >= 2 && petitionUnits.length <= 3 ? (
                      <button
                        type="button"
                        className="rounded-md bg-slate-50 px-2 py-1 text-left hover:bg-slate-100"
                        onClick={() =>
                          goSearch(
                            {
                              signed: [],
                              ...superSignerFilters(selectedPetitions),
                            },
                            "petition",
                          )
                        }
                      >
                        <p className="text-[10px] text-slate-500">
                          Super signers
                        </p>
                        <p className="text-xs font-semibold text-slate-900">
                          {unitSuperSigners.toLocaleString()}
                        </p>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn-primary px-3 py-1.5 text-xs"
                      onClick={() => setExportOpen(true)}
                    >
                      Export
                    </button>
                  </div>
                </div>
                <PetitionCombinations
                  compact
                  units={petitionUnits}
                  combos={chartSummary?.petition_combos}
                  onSelectUnitCombo={(mask) =>
                    navigateToSearch(
                      navigate,
                      mergeFiltersWithUnitCombo(filters, mask, petitionUnits),
                      { find: "petition" },
                    )
                  }
                  onSelectPetitionExclusive={(p) =>
                    navigateToSearch(
                      navigate,
                      mergeFiltersWithCombo(
                        filters,
                        2 ** p.bit_index,
                        selectedPetitions,
                      ),
                      { find: p.label || "petition" },
                    )
                  }
                  onSelectSuperSigners={() =>
                    goSearch(
                      {
                        signed: [],
                        ...superSignerFilters(selectedPetitions),
                      },
                      "petition",
                    )
                  }
                />
              </section>
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              <ChartCard title="By party" height="h-48">
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
                      const name = chartLabel(data);
                      if (name) goSearch({ party: [name] }, "party");
                    }}
                  />
                </BarChart>
              </ChartCard>

              <ChartCard title="By age" height="h-48">
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
                      const name = chartLabel(data);
                      if (!name) return;
                      const range = ageBandToRange(name);
                      if (range) goSearch(range, "age");
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
                      const name = chartLabel(data);
                      if (name) goSearch({ county: [name] }, "county");
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
                  Click a county to plot every geocoded voter. Use the legend to
                  hide voters, yard signs, or volunteers. Chart clicks open
                  Search with Filters — map stays here.
                </p>
              </div>
              {mapError && focusCounty ? (
                <Alert variant="error">{mapError}</Alert>
              ) : null}
              <VoterMap
                countyCounts={countyCounts}
                focusCounty={focusCounty}
                onCountyClick={openCountyPins}
                onClearFocus={clearMapFocus}
                onOpenProfile={setProfileId}
                coords={coords}
                campaignGeo={campaignGeo}
                truncated={truncated}
                totalVoters={summary.total}
                pinsLoading={pinsLoading}
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

function pctOfInterest(part: number, taggedTotal: number) {
  if (!taggedTotal) return "0% of tagged";
  return `${((100 * part) / taggedTotal).toFixed(1)}% of tagged`;
}

function chartLabel(data: unknown): string | undefined {
  if (data == null || typeof data !== "object") return undefined;
  const rec = data as {
    name?: unknown;
    payload?: { name?: unknown };
    tooltipPayload?: Array<{ payload?: { name?: unknown } }>;
  };
  if (typeof rec.name === "string" && rec.name) return rec.name;
  if (typeof rec.payload?.name === "string" && rec.payload.name) {
    return rec.payload.name;
  }
  const tip = rec.tooltipPayload?.[0]?.payload?.name;
  if (typeof tip === "string" && tip) return tip;
  return undefined;
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
  const display = value == null ? "—" : value.toLocaleString();
  const className = `card p-3 text-left ${onClick ? "cursor-pointer transition hover:border-brand-300 hover:bg-brand-50/40" : ""}`;
  const body = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-0.5 text-xl font-bold text-slate-900">{display}</p>
      {hint ? (
        <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>
      ) : null}
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
  height = "h-48",
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
