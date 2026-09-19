import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Alert, EmptyState, PageHeader, Spinner } from "../components/ui";
import { PetitionExportModal } from "../components/PetitionExportModal";
import {
  EMPTY_FILTER_OPTIONS,
  mergeOptions,
  VoterFiltersPanel,
  type FilterOptions,
} from "../components/VoterFiltersPanel";
import { NearbyPinModal } from "../components/NearbyPinModal";
import { VoterProfileModal } from "../components/VoterProfileModal";
import {
  autoMergeSureDuplicates,
  deleteVoters,
  fetchAnalytics,
  fetchFilterOptions,
  fetchSearch,
  type NearbyKind,
} from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { logActivity } from "../lib/activityLog";
import {
  downloadVotersCsv,
  MAX_EXPORT_ROWS,
  sleep,
  VOTER_EXPORT_COLS,
} from "../lib/exportVotersCsv";
import { emptyFilters, filtersActive, summarizeFilters } from "../lib/filters";
import {
  SEARCH_FILTERS_HANDOFF_KEY,
  SEARCH_FILTER_FIND_KEY,
  SEARCH_OPEN_FILTERS_KEY,
  clearPersistedSearchFilters,
  type SearchLocationState,
} from "../lib/navigateToSearch";
import {
  buildPetitionUnits,
  comboExportFilename,
  filtersForSignedAny,
  mergeFiltersWithCombo,
  usePetitions,
  useSelectedPetitions,
} from "../lib/petitions";
import type { PetitionComboCount, VoterFilters, VoterRow } from "../lib/types";

const PAGE_SIZE = 50;

function filtersFromLocation(state: unknown): VoterFilters | null {
  if (!state || typeof state !== "object") return null;
  const filters = (state as SearchLocationState).filters;
  if (!filters || typeof filters !== "object") return null;
  return { ...emptyFilters(), ...filters };
}

function readHandoffFilters(state: unknown): VoterFilters {
  const fromNav = filtersFromLocation(state);
  if (fromNav) return fromNav;
  try {
    const handoff = sessionStorage.getItem(SEARCH_FILTERS_HANDOFF_KEY);
    if (handoff) {
      return { ...emptyFilters(), ...JSON.parse(handoff) };
    }
  } catch {
    /* ignore */
  }
  return emptyFilters();
}

function readFiltersOpen(state: unknown): boolean {
  if (state && typeof state === "object" && (state as SearchLocationState).openFilters) {
    return true;
  }
  try {
    return sessionStorage.getItem(SEARCH_OPEN_FILTERS_KEY) === "1";
  } catch {
    return false;
  }
}

function readFilterFind(state: unknown): string {
  if (state && typeof state === "object") {
    const find = (state as SearchLocationState).find;
    if (typeof find === "string" && find.trim()) return find.trim();
  }
  try {
    return sessionStorage.getItem(SEARCH_FILTER_FIND_KEY) ?? "";
  } catch {
    return "";
  }
}

export default function Search() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const location = useLocation();
  const [filters, setFilters] = useState<VoterFilters>(() =>
    readHandoffFilters(location.state),
  );
  const [filtersOpen, setFiltersOpen] = useState(() =>
    readFiltersOpen(location.state),
  );
  const [filterFind, setFilterFind] = useState(() =>
    readFilterFind(location.state),
  );
  const [exportOpen, setExportOpen] = useState(false);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<VoterRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportingKey, setExportingKey] = useState<string | number | null>(
    null,
  );
  const [exportingAll, setExportingAll] = useState(false);
  const [petitionCombos, setPetitionCombos] = useState<
    PetitionComboCount[] | null
  >(null);
  const [deleting, setDeleting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [profileId, setProfileId] = useState<number | null>(null);
  const [nearbyModal, setNearbyModal] = useState<{
    voterId: number;
    kind: NearbyKind;
  } | null>(null);
  const [options, setOptions] = useState<FilterOptions>(EMPTY_FILTER_OPTIONS);
  const { activePetitions: allPetitions, groups: petitionGroups } =
    usePetitions();
  const {
    slugs: selectedSlugs,
    selected: selectedPetitions,
    isDefaultSelection,
  } = useSelectedPetitions(allPetitions);

  const petitionUnits = useMemo(
    () => buildPetitionUnits(selectedPetitions, petitionGroups),
    [selectedPetitions, petitionGroups],
  );

  const activeFilterChips = useMemo(() => summarizeFilters(filters), [filters]);

  useEffect(() => {
    clearPersistedSearchFilters();
    try {
      sessionStorage.removeItem(SEARCH_FILTERS_HANDOFF_KEY);
      sessionStorage.removeItem(SEARCH_OPEN_FILTERS_KEY);
      sessionStorage.removeItem(SEARCH_FILTER_FIND_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!filtersOpen) return;
    void fetchFilterOptions()
      .then((o) => setOptions(mergeOptions(o)))
      .catch(() => setOptions(EMPTY_FILTER_OPTIONS));
  }, [filtersOpen]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const t = setTimeout(() => {
      void fetchSearch({ filters, q, page, pageSize: PAGE_SIZE })
        .then((data) => {
          if (!active) return;
          setRows(data.rows);
          setTotal(data.total);
        })
        .catch((err: Error) => {
          if (!active) return;
          setError(err.message);
          if (!/timed out|522|unreachable/i.test(err.message)) {
            setRows([]);
            setTotal(0);
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 100);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [filters, q, page, refreshNonce]);

  // Petition combo counts for the current filter universe.
  useEffect(() => {
    if (!exportOpen) return;
    let active = true;
    const t = setTimeout(() => {
      void fetchAnalytics(
        filters,
        isDefaultSelection ? undefined : selectedSlugs,
      )
        .then((data) => {
          if (active) setPetitionCombos(data.petition_combos ?? null);
        })
        .catch(() => {
          if (active) setPetitionCombos(null);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [exportOpen, filters, isDefaultSelection, selectedSlugs]);

  // Drop selection when the result universe changes (not on pagination).
  useEffect(() => {
    setSelected(new Set());
  }, [filters, q]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const allPageSelected =
    pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0;

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  };

  const handleExport = async () => {
    const unfiltered = !filtersActive(filters);
    if (unfiltered && !isAdmin) {
      setError(
        "Filter the list before exporting. Downloading the whole voter file takes the database down.",
      );
      return;
    }
    if (q.trim()) {
      const ok = window.confirm(
        `CSV export uses filters only — it does not use the search box (“${q.trim()}”). Continue exporting the filtered list?`,
      );
      if (!ok) return;
    }
    if (unfiltered && isAdmin) {
      const ok = window.confirm(
        `This will export up to ${MAX_EXPORT_ROWS.toLocaleString()} of ${total.toLocaleString()} voters with no filters.\n\nA full-file download is what crashed the voter database. Continue?`,
      );
      if (!ok) return;
    } else if (total > 3000) {
      const parts = Math.max(1, Math.ceil(total / MAX_EXPORT_ROWS));
      const ok = window.confirm(
        `This will download about ${total.toLocaleString()} rows` +
          (parts > 1
            ? ` in ${parts} files of ${MAX_EXPORT_ROWS.toLocaleString()}`
            : '') +
          `. Large lists page slowly so the database stays up — you still get the full filtered list. Continue?`,
      );
      if (!ok) return;
    }
    setExporting(true);
    setError(null);
    setNotice(null);
    try {
      const { count, truncated, files } = await downloadVotersCsv({
        filters,
        filename: `voters-export-${new Date().toISOString().slice(0, 10)}.csv`,
        columns: VOTER_EXPORT_COLS,
      });
      void logActivity({
        action: "export",
        entityType: "voter",
        metadata: { label: "CSV export", count, truncated, files },
      });
      if (truncated && unfiltered) {
        setNotice(
          `Unfiltered export stopped at ${MAX_EXPORT_ROWS.toLocaleString()} rows. Filter the list to download a complete set.`,
        );
      } else if (files > 1) {
        setNotice(`Downloaded ${count.toLocaleString()} people in ${files} files.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const exportSignedAny = async (
    slugs: string[],
    filename: string,
    key: string,
  ) => {
    setExportingKey(key);
    setError(null);
    try {
      const { signed: _s, signed_min: _m, signed_min_of: _o, ...rest } =
        filters;
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
    const rowsToExport = [...(petitionCombos ?? [])]
      .map((c) => ({ mask: Number(c.mask), count: Number(c.count) || 0 }))
      .filter((c) => c.count > 0 && c.mask !== 0);
    const rowTotal = rowsToExport.reduce((s, c) => s + c.count, 0);
    if (rowsToExport.length === 0) return;
    const ok = window.confirm(
      `This will download ${rowsToExport.length} combination lists (~${rowTotal.toLocaleString()} people). Lists over ${MAX_EXPORT_ROWS.toLocaleString()} split into files with a pause between them so the database stays up.\n\nYou get every person. Continue?`,
    );
    if (!ok) return;
    setExportingAll(true);
    setError(null);
    try {
      let totalExported = 0;
      for (const combo of rowsToExport) {
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
        totalExported += count;
        await sleep(800);
      }
      void logActivity({
        action: "export",
        entityType: "voter",
        metadata: {
          label: `Petition combo CSV (all ${rowsToExport.length})`,
          count: totalExported,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExportingKey(null);
      setExportingAll(false);
    }
  };

  const handleAutoMerge = async () => {
    const ok = window.confirm(
      "Merge records that are the same person: same name + street, same Murmuration ID, name + birth year, or email/phone + name.\n\nThe richer row (party / ID / petitions) is kept. This cannot be undone.",
    );
    if (!ok) return;
    setMerging(true);
    setError(null);
    setNotice(null);
    try {
      const res = await autoMergeSureDuplicates();
      void logActivity({
        action: "update",
        entityType: "voter",
        metadata: {
          label: "Auto-merge sure duplicates",
          count: res.merged,
        },
      });
      setRefreshNonce((n) => n + 1);
      if (res.merged === 0) {
        setError(
          res.found
            ? `Found ${res.found.toLocaleString()} duplicate pair${res.found === 1 ? "" : "s"} but none could be merged (${res.skipped} skipped).`
            : "No name+address duplicates found. Apply migration 0051 (APPLY_FROM=0051 npm run db:apply-campaign) and restart npm run dev if this is the first time.",
        );
      } else {
        setNotice(
          `Merged ${res.merged.toLocaleString()} duplicate record${res.merged === 1 ? "" : "s"}${
            res.skipped ? ` (${res.skipped} skipped)` : ""
          }. Click again if more remain.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Auto-merge failed");
    } finally {
      setMerging(false);
    }
  };

  const handleDeleteSelected = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    const ok = window.confirm(
      `Permanently delete ${ids.length.toLocaleString()} selected voter${ids.length === 1 ? "" : "s"} from analytics?\n\nThis cannot be undone (re-import to restore).`,
    );
    if (!ok) return;

    setDeleting(true);
    setError(null);
    try {
      const res = await deleteVoters(ids);
      void logActivity({
        action: "delete",
        entityType: "voter",
        metadata: { label: "Delete selected voters", count: res.deleted },
      });
      setSelected(new Set());
      setRows((prev) => prev.filter((r) => !ids.includes(r.id)));
      setTotal((t) => Math.max(0, t - res.deleted));
      // Refresh to keep pagination totals accurate
      const data = await fetchSearch({ filters, q, page, pageSize: PAGE_SIZE });
      setRows(data.rows);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Voter Search"
        description="Filtered list of people. Open Filters to refine, or Export for CSVs."
        actions={
          <div className="flex flex-wrap gap-2">
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
            {someSelected ? (
              <button
                type="button"
                className="btn-danger"
                disabled={deleting}
                onClick={() => void handleDeleteSelected()}
              >
                {deleting ? "Deleting…" : `Delete selected (${selected.size})`}
              </button>
            ) : null}
            {isAdmin ? (
              <button
                type="button"
                className="btn-secondary"
                disabled={merging}
                onClick={() => void handleAutoMerge()}
              >
                {merging ? "Merging…" : "Auto-merge duplicates"}
              </button>
            ) : null}
            <button
              type="button"
              className="btn-secondary"
              disabled={exporting || total === 0}
              onClick={() => void handleExport()}
            >
              {exporting ? "Exporting…" : "Export CSV"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setExportOpen(true)}
            >
              Petition combos
            </button>
          </div>
        }
      />

      {activeFilterChips.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {activeFilterChips.slice(0, 10).map((chip) => (
            <span
              key={chip}
              className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700"
            >
              {chip}
            </span>
          ))}
          <button
            type="button"
            className="text-[11px] font-medium text-brand-700 hover:underline"
            onClick={() => {
              setPage(1);
              clearPersistedSearchFilters();
              setFilters(emptyFilters());
            }}
          >
            Clear
          </button>
        </div>
      ) : null}

      <VoterFiltersPanel
        asDrawer
        open={filtersOpen}
        onClose={() => {
          setFiltersOpen(false);
          setFilterFind("");
        }}
        filters={filters}
        onChange={(f) => {
          setPage(1);
          setFilters(f);
        }}
        options={options}
        matchCount={total}
        findQuery={filterFind}
      />

      <PetitionExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        units={petitionUnits}
        petitions={selectedPetitions}
        combos={petitionCombos}
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

      <div className="space-y-4">
        <div className="card p-4">
          <label className="label" htmlFor="q">
            Search
          </label>
          <input
            id="q"
            className="input"
            placeholder="Name, voter ID, address, city, ZIP, email, phone…"
            value={q}
            onChange={(e) => {
              setPage(1);
              setQ(e.target.value);
            }}
          />
        </div>

        {error && <Alert variant="error">{error}</Alert>}
        {notice && <Alert variant="success">{notice}</Alert>}

        {loading && rows.length === 0 ? (
          <Spinner label="Searching…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No matching voters"
            description="Adjust filters or search terms, or import a voter file."
          />
        ) : (
          <div className="card overflow-x-auto">
            {someSelected ? (
              <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                <span>
                  <span className="font-semibold text-slate-800">
                    {selected.size}
                  </span>{" "}
                  selected
                </span>
                <button
                  type="button"
                  className="btn-ghost px-2 py-1 text-xs"
                  onClick={() => setSelected(new Set())}
                >
                  Clear selection
                </button>
              </div>
            ) : null}
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={allPageSelected}
                      onChange={togglePage}
                      aria-label="Select all on page"
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                  </th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Supporter</th>
                  <th className="px-3 py-2 font-medium">Nearby</th>
                  <th className="px-3 py-2 font-medium">Address</th>
                  <th className="px-3 py-2 font-medium">Party</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const tag = r.supporter_tag?.trim();
                  const checked = selected.has(r.id);
                  return (
                    <tr
                      key={r.id}
                      className={`border-b border-slate-100 last:border-0 ${
                        checked ? "bg-brand-50/40" : ""
                      }`}
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleOne(r.id)}
                          aria-label={`Select ${[r.first_name, r.last_name].filter(Boolean).join(" ") || r.id}`}
                          className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                        />
                      </td>
                      <td className="px-3 py-2 font-medium text-slate-800">
                        <button
                          type="button"
                          className="text-left font-medium text-brand-700 hover:underline"
                          onClick={() => setProfileId(r.id)}
                        >
                          {[r.first_name, r.last_name]
                            .filter(Boolean)
                            .join(" ") || "Unnamed"}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium capitalize ${
                            tag === "supporter"
                              ? "bg-emerald-100 text-emerald-800"
                              : tag === "opposed"
                                ? "bg-rose-100 text-rose-800"
                                : tag === "maybe"
                                  ? "bg-amber-100 text-amber-900"
                                  : "bg-slate-100 text-slate-700"
                          }`}
                        >
                          {tag || (r.is_campaign_volunteer ? "volunteer" : "—")}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        <NearbyCell
                          row={r}
                          onOpen={(kind) =>
                            setNearbyModal({ voterId: r.id, kind })
                          }
                        />
                      </td>
                      <td className="px-3 py-2 text-slate-600">
                        {[r.address_line_1, r.city, r.zip]
                          .filter(Boolean)
                          .join(", ")}
                      </td>
                      <td className="px-3 py-2 text-slate-600">{r.party}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-3 py-2">
              <p className="text-xs text-slate-500">
                Page {page} of {totalPages} · {total.toLocaleString()} results
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-secondary px-3 py-1.5 text-xs"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn-secondary px-3 py-1.5 text-xs"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {profileId != null && (
        <VoterProfileModal
          voterId={profileId}
          onClose={() => setProfileId(null)}
        />
      )}

      {nearbyModal != null && (
        <NearbyPinModal
          voterId={nearbyModal.voterId}
          kind={nearbyModal.kind}
          onClose={() => setNearbyModal(null)}
        />
      )}
    </div>
  );
}

function NearbyCell({
  row,
  onOpen,
}: {
  row: VoterRow;
  onOpen: (kind: NearbyKind) => void;
}) {
  const parts: ReactNode[] = [];
  const yard = row.nearby_yard_sign_miles;
  const vol = row.nearby_volunteer_miles;
  const hasCoords =
    (row.lat != null && row.lng != null) ||
    (yard != null && Number.isFinite(Number(yard))) ||
    (vol != null && Number.isFinite(Number(vol)));
  const hasAddress = Boolean(
    row.address_line_1?.trim() || row.city?.trim() || row.zip?.trim(),
  );

  if (yard != null && Number.isFinite(Number(yard))) {
    parts.push(
      <button
        key="yard"
        type="button"
        className="font-medium text-amber-700 underline decoration-amber-300 underline-offset-2 hover:text-amber-900"
        onClick={(e) => {
          e.stopPropagation();
          onOpen("yard_sign");
        }}
      >
        Yard {Number(yard).toFixed(1)} mi
      </button>,
    );
  }
  if (vol != null && Number.isFinite(Number(vol))) {
    if (parts.length) {
      parts.push(
        <span key="sep" className="text-slate-400">
          {" · "}
        </span>,
      );
    }
    parts.push(
      <button
        key="vol"
        type="button"
        className="font-medium text-sky-700 underline decoration-sky-300 underline-offset-2 hover:text-sky-900"
        onClick={(e) => {
          e.stopPropagation();
          onOpen("volunteer");
        }}
      >
        Vol {Number(vol).toFixed(1)} mi
      </button>,
    );
  }

  if (parts.length) {
    return (
      <span className="inline-flex flex-wrap items-center gap-0.5">
        {parts}
      </span>
    );
  }

  if (hasAddress && !hasCoords) {
    return (
      <button
        type="button"
        className="text-left text-[11px] font-medium text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-brand-700"
        title="No lat/lng on file — click to geocode address and find nearest pin"
        onClick={(e) => {
          e.stopPropagation();
          onOpen("yard_sign");
        }}
      >
        Locate…
      </button>
    );
  }

  return <span className="text-slate-400">—</span>;
}
