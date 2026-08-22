import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UniverseEditorModal } from '../components/UniverseEditorModal';
import { Alert, EmptyState, PageHeader, Spinner } from '../components/ui';
import {
  createUniverse,
  deleteUniverse,
  listUniverses,
  recomputeSupporterTags,
  updateUniverse,
} from '../lib/api';
import { logActivity } from '../lib/activityLog';
import { emptyFilters, summarizeFilters } from '../lib/filters';
import { navigateToSearch } from '../lib/navigateToSearch';
import {
  SUPPORTER_TAG_PRESETS,
  universeHasFormHandlerRules,
  universeOrigin,
} from '../lib/supporterPresets';
import type { SavedUniverse, VoterFilters } from '../lib/types';

export default function Universes() {
  const navigate = useNavigate();
  const [universes, setUniverses] = useState<SavedUniverse[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SavedUniverse | null>(null);
  const [draft, setDraft] = useState<SavedUniverse | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const u = await listUniverses();
      setUniverses(u.universes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const openNew = () => {
    setEditing(null);
    setDraft(null);
    setError(null);
    setEditorOpen(true);
  };

  const openEdit = (u: SavedUniverse) => {
    setEditing(u);
    setDraft(u);
    setError(null);
    setEditorOpen(true);
  };

  const openPreset = (name: string) => {
    const preset = SUPPORTER_TAG_PRESETS.find((p) => p.name === name);
    if (!preset) return;
    const existing = universes.find((u) => u.name === preset.name) ?? null;
    const filters = { ...emptyFilters(), any_of: preset.any_of };
    const draftRow: SavedUniverse = existing
      ? {
          ...existing,
          filters,
          supporter_tag: preset.supporter_tag,
          tag_priority: preset.tag_priority,
        }
      : {
          id: '',
          name: preset.name,
          filters,
          supporter_tag: preset.supporter_tag,
          tag_priority: preset.tag_priority,
          source: preset.source,
          created_by: '',
          created_at: '',
          updated_at: '',
        };
    setEditing(existing);
    setDraft(draftRow);
    setError(null);
    setEditorOpen(true);
  };

  const save = async (next: {
    name: string;
    filters: VoterFilters;
    supporter_tag: string | null;
    tag_priority: number;
  }) => {
    if (!next.name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const isPresetName = SUPPORTER_TAG_PRESETS.some((p) => p.name === next.name);
      const source =
        isPresetName || editing?.source === 'preset' ? 'preset' : 'custom';
      if (editing?.id) {
        await updateUniverse(editing.id, {
          name: next.name.trim(),
          filters: next.filters,
          supporter_tag: next.supporter_tag,
          tag_priority: next.tag_priority,
          source,
        });
      } else {
        const { universe } = await createUniverse(next.name.trim(), next.filters, {
          supporter_tag: next.supporter_tag,
          tag_priority: next.tag_priority,
          source,
        });
        void logActivity({
          action: 'create',
          entityType: 'universe',
          entityId: universe.id,
          metadata: { label: universe.name },
        });
      }
      setEditorOpen(false);
      setEditing(null);
      setDraft(null);
      setNotice(
        next.supporter_tag
          ? 'Saved. Analytics supporter / maybe / opposed counts will refresh in a few seconds.'
          : 'Saved.',
      );
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const apply = (u: SavedUniverse) => {
    navigateToSearch(navigate, { ...emptyFilters(), ...u.filters });
  };

  const saveAllTagPresets = async () => {
    setSeeding(true);
    setError(null);
    setNotice(null);
    try {
      for (const preset of SUPPORTER_TAG_PRESETS) {
        const existing = universes.find((u) => u.name === preset.name);
        const filters = { ...emptyFilters(), any_of: preset.any_of };
        if (existing) {
          await updateUniverse(existing.id, {
            filters,
            supporter_tag: preset.supporter_tag,
            tag_priority: preset.tag_priority,
            source: preset.source,
            skip_recompute: true,
          });
        } else {
          const { universe } = await createUniverse(preset.name, filters, {
            supporter_tag: preset.supporter_tag,
            tag_priority: preset.tag_priority,
            source: preset.source,
            skip_recompute: true,
          });
          void logActivity({
            action: 'create',
            entityType: 'universe',
            entityId: universe.id,
            metadata: { label: universe.name },
          });
        }
      }
      void recomputeSupporterTags();
      setNotice(
        'Presets saved. Analytics supporter counts will refresh in a few seconds.',
      );
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
        description="Named audiences. Edit one to change petitions, convos, and FormHandler activity (volunteers, donors, attendees, yard signs)."
        actions={
          <button type="button" className="btn-primary" onClick={openNew}>
            New universe
          </button>
        }
      />

      {error && !editorOpen ? (
        <div className="mb-4">
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      {notice && !editorOpen ? (
        <div className="mb-4">
          <Alert variant="success">{notice}</Alert>
        </div>
      ) : null}

      <div className="mb-4 card space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">
              Organizer tag presets
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Achilles Vote includes FormHandler volunteers, donors, attendees,
              yard signs, and newsletters. Opens the editor so you can change
              what counts.
            </p>
          </div>
          <button
            type="button"
            className="btn-secondary shrink-0 text-xs"
            disabled={seeding}
            onClick={() => void saveAllTagPresets()}
          >
            {seeding ? 'Saving…' : 'Save / update tag universes'}
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {SUPPORTER_TAG_PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-left hover:border-brand-300 hover:bg-brand-50/40"
              onClick={() => openPreset(p.name)}
            >
              <p className="text-sm font-medium text-slate-800">{p.name}</p>
              <p className="text-[11px] text-indigo-700">tag: {p.supporter_tag}</p>
              <p className="mt-1 text-[11px] text-slate-500">{p.description}</p>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <Spinner label="Loading universes…" />
      ) : universes.length === 0 ? (
        <EmptyState
          title="No saved universes"
          description="Create a universe or save the tag presets above."
        />
      ) : (
        <ul className="space-y-3">
          {universes.map((u) => {
            const parts = summarizeFilters(u.filters);
            const origin = universeOrigin(u);
            const includesFh = universeHasFormHandlerRules(u.filters);
            return (
              <li key={u.id} className="card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-slate-900">{u.name}</h3>
                      {origin === 'preset' ? (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                          Tag preset
                        </span>
                      ) : null}
                      {includesFh ? (
                        <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal-800">
                          FormHandler
                        </span>
                      ) : null}
                    </div>
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
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-secondary px-3 py-1.5 text-xs"
                      onClick={() => openEdit(u)}
                    >
                      Edit
                    </button>
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

      <UniverseEditorModal
        open={editorOpen}
        universe={draft}
        isEdit={Boolean(editing?.id)}
        saving={saving}
        error={editorOpen ? error : null}
        onClose={() => {
          setEditorOpen(false);
          setEditing(null);
          setDraft(null);
          setError(null);
        }}
        onSave={(next) => void save(next)}
      />
    </div>
  );
}
