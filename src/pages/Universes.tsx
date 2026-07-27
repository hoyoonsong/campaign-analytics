import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, EmptyState, PageHeader, Spinner } from '../components/ui';
import {
  EMPTY_FILTER_OPTIONS,
  mergeOptions,
  VoterFiltersPanel,
  type FilterOptions,
} from '../components/VoterFiltersPanel';
import {
  createUniverse,
  deleteUniverse,
  fetchFilterOptions,
  listUniverses,
  updateUniverse,
} from '../lib/api';
import { logActivity } from '../lib/activityLog';
import { emptyFilters, summarizeFilters } from '../lib/filters';
import {
  SUPPORTER_TAG_PRESETS,
  type SupporterTagPreset,
} from '../lib/supporterPresets';
import type { SavedUniverse, VoterFilters } from '../lib/types';

export default function Universes() {
  const navigate = useNavigate();
  const [universes, setUniverses] = useState<SavedUniverse[]>([]);
  const [name, setName] = useState('');
  const [supporterTag, setSupporterTag] = useState('');
  const [tagPriority, setTagPriority] = useState(0);
  const [filters, setFilters] = useState<VoterFilters>(emptyFilters());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<FilterOptions>(EMPTY_FILTER_OPTIONS);

  const reload = async () => {
    setLoading(true);
    try {
      const [u, o] = await Promise.all([listUniverses(), fetchFilterOptions()]);
      setUniverses(u.universes);
      setOptions(mergeOptions(o));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const save = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const tag = supporterTag.trim();
      const { universe } = await createUniverse(name.trim(), filters, {
        supporter_tag: tag || null,
        tag_priority: tagPriority,
      });
      void logActivity({
        action: 'create',
        entityType: 'universe',
        entityId: universe.id,
        metadata: { label: universe.name },
      });
      setName('');
      setSupporterTag('');
      setTagPriority(0);
      setFilters(emptyFilters());
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const apply = (u: SavedUniverse) => {
    sessionStorage.setItem('voter_universe_filters', JSON.stringify(u.filters));
    navigate('/search');
  };

  const loadPreset = (preset: SupporterTagPreset) => {
    setName(preset.name);
    setSupporterTag(preset.supporter_tag);
    setTagPriority(preset.tag_priority);
    setFilters({ ...emptyFilters(), any_of: preset.any_of });
  };

  const saveAllTagPresets = async () => {
    setSeeding(true);
    setError(null);
    try {
      for (const preset of SUPPORTER_TAG_PRESETS) {
        const existing = universes.find((u) => u.name === preset.name);
        const filters = { ...emptyFilters(), any_of: preset.any_of };
        if (existing) {
          await updateUniverse(existing.id, {
            filters,
            supporter_tag: preset.supporter_tag,
            tag_priority: preset.tag_priority,
          });
        } else {
          const { universe } = await createUniverse(preset.name, filters, {
            supporter_tag: preset.supporter_tag,
            tag_priority: preset.tag_priority,
          });
          void logActivity({
            action: 'create',
            entityType: 'universe',
            entityId: universe.id,
            metadata: { label: universe.name },
          });
        }
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save presets');
    } finally {
      setSeeding(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this saved universe?')) return;
    try {
      await deleteUniverse(id);
      void logActivity({
        action: 'delete',
        entityType: 'universe',
        entityId: id,
      });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  return (
    <div>
      <PageHeader
        title="Saved universes"
        description="Save filter sets (OR + AND). Mark a universe as a Supporter tag so Search shows supporter / maybe / opposed."
      />

      {error && (
        <div className="mb-4">
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      <div className="mb-4 card space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">
              Organizer tag presets
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              OR rules matching your Achilles Vote / Maybe / Oppose communities.
              Saves as tagged universes for the Search Supporter column.
            </p>
          </div>
          <button
            type="button"
            className="btn-secondary shrink-0 text-xs"
            disabled={seeding}
            onClick={() => void saveAllTagPresets()}
          >
            {seeding ? 'Saving…' : 'Save / update all 3 tag universes'}
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {SUPPORTER_TAG_PRESETS.map((p) => (
            <button
              key={p.supporter_tag}
              type="button"
              className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-left hover:border-brand-300 hover:bg-brand-50/40"
              onClick={() => loadPreset(p)}
            >
              <p className="text-sm font-medium text-slate-800">{p.name}</p>
              <p className="text-[11px] text-indigo-700">tag: {p.supporter_tag}</p>
              <p className="mt-1 text-[11px] text-slate-500">{p.description}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <div className="space-y-4">
          <VoterFiltersPanel filters={filters} onChange={setFilters} options={options} />
          <div className="card space-y-3 p-4">
            <div>
              <label className="label" htmlFor="universe-name">
                Universe name
              </label>
              <input
                id="universe-name"
                className="input"
                placeholder="e.g. Ada Young Unaffiliated"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="supporter-tag">
                Supporter tag (optional)
              </label>
              <input
                id="supporter-tag"
                className="input"
                placeholder="e.g. opposed, unknown, supporter"
                value={supporterTag}
                onChange={(e) => setSupporterTag(e.target.value)}
              />
              <p className="mt-1 text-[11px] text-slate-500">
                When set, matching voters get this label in Search (higher priority
                overwrites lower).
              </p>
            </div>
            <div>
              <label className="label" htmlFor="tag-priority">
                Tag priority
              </label>
              <input
                id="tag-priority"
                type="number"
                className="input"
                value={tagPriority}
                onChange={(e) => setTagPriority(Number(e.target.value) || 0)}
              />
            </div>
            <button
              type="button"
              className="btn-primary w-full"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save universe'}
            </button>
          </div>
        </div>

        <div>
          {loading ? (
            <Spinner label="Loading universes…" />
          ) : universes.length === 0 ? (
            <EmptyState
              title="No saved universes"
              description="Build a filter set on the left and save it with a name."
            />
          ) : (
            <ul className="space-y-3">
              {universes.map((u) => {
                const parts = summarizeFilters(u.filters);
                return (
                  <li key={u.id} className="card p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold text-slate-900">{u.name}</h3>
                        {u.supporter_tag ? (
                          <p className="mt-1 text-xs font-medium text-indigo-700">
                            Supporter tag: {u.supporter_tag}
                            {u.tag_priority != null ? ` (priority ${u.tag_priority})` : ''}
                          </p>
                        ) : null}
                        <p className="mt-1 text-xs text-slate-500">
                          Updated {new Date(u.updated_at).toLocaleString()}
                        </p>
                        {parts.length > 0 ? (
                          <ul className="mt-2 space-y-0.5 text-sm text-slate-600">
                            {parts.map((p) => (
                              <li key={p}>{p}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="mt-2 text-sm text-slate-400">No filters (all voters)</p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="btn-primary px-3 py-1.5 text-xs"
                          onClick={() => apply(u)}
                        >
                          Apply in Search
                        </button>
                        <button
                          type="button"
                          className="btn-danger px-3 py-1.5 text-xs"
                          onClick={() => void remove(u.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
