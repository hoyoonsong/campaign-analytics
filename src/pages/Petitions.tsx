import { useMemo, useState } from 'react';
import { Alert, Modal, PageHeader, Spinner } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import {
  createPetitionApi,
  createPetitionGroupApi,
  clearClientDataCaches,
  deletePetitionApi,
  deletePetitionGroupApi,
  updatePetitionApi,
  updatePetitionGroupApi,
} from '../lib/api';
import {
  buildPetitionUnits,
  type Petition,
  type PetitionGroup,
  usePetitions,
} from '../lib/petitions';

export default function PetitionsPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const { petitions, groups, loading, error, reload } = usePetitions();
  const [newLabel, setNewLabel] = useState('');
  const [checked, setChecked] = useState<Set<number>>(() => new Set());
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupLabel, setGroupLabel] = useState('');
  const [groupShort, setGroupShort] = useState('');
  const [addToId, setAddToId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const units = useMemo(
    () => buildPetitionUnits(petitions, groups),
    [petitions, groups],
  );

  const checkedList = petitions.filter((p) => checked.has(p.id));

  const create = async () => {
    if (!newLabel.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await createPetitionApi({ label: newLabel.trim() });
      setNewLabel('');
      setMsg('Petition created.');
      clearClientDataCaches();
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (p: Petition, next: Partial<Petition>) => {
    setBusy(true);
    setErr(null);
    try {
      await updatePetitionApi({ id: p.id, ...next });
      clearClientDataCaches();
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: Petition) => {
    if (
      !window.confirm(
        `Delete “${p.label}”? Signature rows for this petition are removed. Deactivate it instead if you might re-import.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await deletePetitionApi(p.id);
      setChecked((cur) => {
        const next = new Set(cur);
        next.delete(p.id);
        return next;
      });
      setMsg(`Deleted ${p.label}.`);
      clearClientDataCaches();
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const openGroupModal = () => {
    const sample = checkedList[0];
    setGroupLabel(sample?.label.replace(/\s*\(.*\)\s*$/, '').trim() || 'Group');
    setGroupShort(sample?.short_label || 'Group');
    setGroupOpen(true);
  };

  const createGroup = async () => {
    if (!groupLabel.trim() || checkedList.length < 2) return;
    setBusy(true);
    setErr(null);
    try {
      await createPetitionGroupApi({
        label: groupLabel.trim(),
        short_label: groupShort.trim() || groupLabel.trim(),
        petition_ids: checkedList.map((p) => p.id),
      });
      setChecked(new Set());
      setGroupOpen(false);
      setMsg('Group created. Analytics will show these as one bar.');
      clearClientDataCaches();
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Group failed');
    } finally {
      setBusy(false);
    }
  };

  const addCheckedToGroup = async (groupId: number) => {
    if (!checkedList.length) return;
    setBusy(true);
    setErr(null);
    try {
      for (const p of checkedList) {
        if (p.group_id !== groupId) {
          await updatePetitionApi({ id: p.id, group_id: groupId });
        }
      }
      setChecked(new Set());
      setAddToId('');
      clearClientDataCaches();
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not add to group');
    } finally {
      setBusy(false);
    }
  };

  const patchGroup = async (g: PetitionGroup, next: Partial<PetitionGroup>) => {
    setBusy(true);
    setErr(null);
    try {
      await updatePetitionGroupApi({ id: g.id, ...next });
      clearClientDataCaches();
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not rename group');
    } finally {
      setBusy(false);
    }
  };

  const ungroup = async (g: PetitionGroup) => {
    setBusy(true);
    setErr(null);
    try {
      await deletePetitionGroupApi(g.id);
      setMsg(`Ungrouped ${g.label}.`);
      clearClientDataCaches();
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ungroup failed');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: number) => {
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleIds = (ids: number[]) => {
    const allOn = ids.every((id) => checked.has(id));
    setChecked((cur) => {
      const next = new Set(cur);
      if (allOn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };

  return (
    <div>
      <PageHeader
        title="Petitions"
        description="Group similar petitions so Analytics shows one stacked bar. Delete only if you are sure — deactivate to hide instead."
      />
      {error || err ? (
        <Alert variant="error">{err || error}</Alert>
      ) : null}
      {msg ? <p className="mb-3 text-sm text-slate-600">{msg}</p> : null}

      {isAdmin ? (
        <div className="card mb-4 flex flex-wrap items-end gap-2 p-4">
          <label className="min-w-[16rem] flex-1">
            <span className="label">New petition</span>
            <input
              className="input"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="e.g. Ranked Choice Voting"
            />
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !newLabel.trim()}
            onClick={() => void create()}
          >
            Add
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || checkedList.length < 2}
            onClick={openGroupModal}
          >
            Group selected{checkedList.length ? ` (${checkedList.length})` : ''}
          </button>
          {groups.length > 0 ? (
            <select
              className="input w-44 py-2 text-sm"
              value={addToId}
              disabled={busy || checkedList.length === 0}
              onChange={(e) => {
                const v = e.target.value;
                setAddToId(v);
                if (v) void addCheckedToGroup(Number(v));
              }}
            >
              <option value="">Add to group…</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.short_label || g.label}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      ) : (
        <p className="mb-3 text-sm text-slate-500">
          Ask an admin to add, group, or delete petitions.
        </p>
      )}

      {loading ? (
        <Spinner label="Loading petitions…" />
      ) : (
        <div className="card overflow-hidden p-2 sm:p-3">
          <ul className="space-y-1">
            {units.map((unit) => {
              const ids = unit.petitions.map((p) => p.id);
              const selectedCount = ids.filter((id) => checked.has(id)).length;
              const allOn = selectedCount === ids.length && ids.length > 0;
              const someOn = selectedCount > 0 && !allOn;
              const grouped = !!unit.group && unit.petitions.length > 1;
              return (
                <li key={unit.key}>
                  {grouped && unit.group ? (
                    <div className="rounded-md bg-slate-50 px-2 py-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        {isAdmin ? (
                          <input
                            type="checkbox"
                            checked={allOn}
                            ref={(el) => {
                              if (el) el.indeterminate = someOn;
                            }}
                            onChange={() => toggleIds(ids)}
                          />
                        ) : null}
                        {isAdmin ? (
                          <>
                            <input
                              className="input w-20 py-1 text-sm font-medium"
                              defaultValue={unit.group.short_label}
                              key={`gs-${unit.group.id}-${unit.group.short_label}`}
                              onBlur={(e) => {
                                const v = e.target.value.trim();
                                if (
                                  v &&
                                  unit.group &&
                                  v !== unit.group.short_label
                                ) {
                                  void patchGroup(unit.group, {
                                    short_label: v,
                                  });
                                }
                              }}
                            />
                            <input
                              className="input min-w-[12rem] flex-1 py-1 text-sm"
                              defaultValue={unit.group.label}
                              key={`gl-${unit.group.id}-${unit.group.label}`}
                              onBlur={(e) => {
                                const v = e.target.value.trim();
                                if (v && unit.group && v !== unit.group.label) {
                                  void patchGroup(unit.group, { label: v });
                                }
                              }}
                            />
                          </>
                        ) : (
                          <span className="text-sm font-medium text-slate-800">
                            {unit.short_label}{' '}
                            <span className="font-normal text-slate-500">
                              {unit.label}
                            </span>
                          </span>
                        )}
                        <span className="text-[11px] text-slate-500">
                          {unit.petitions.length} petitions
                        </span>
                        {isAdmin ? (
                          <button
                            type="button"
                            className="ml-auto text-xs font-medium text-brand-700 hover:underline"
                            disabled={busy}
                            onClick={() =>
                              unit.group ? void ungroup(unit.group) : undefined
                            }
                          >
                            Ungroup
                          </button>
                        ) : null}
                      </div>
                      <ul className="ml-6 mt-1 space-y-0.5 border-l border-slate-200 pl-3">
                        {unit.petitions.map((p) => (
                          <PetitionRow
                            key={p.id}
                            p={p}
                            nested
                            isAdmin={isAdmin}
                            busy={busy}
                            checked={checked.has(p.id)}
                            onToggle={() => toggle(p.id)}
                            onPatch={patch}
                            onDelete={remove}
                          />
                        ))}
                      </ul>
                    </div>
                  ) : (
                    unit.petitions.map((p) => (
                      <PetitionRow
                        key={p.id}
                        p={p}
                        nested={false}
                        isAdmin={isAdmin}
                        busy={busy}
                        checked={checked.has(p.id)}
                        onToggle={() => toggle(p.id)}
                        onPatch={patch}
                        onDelete={remove}
                      />
                    ))
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <Modal
        open={groupOpen}
        onClose={() => setGroupOpen(false)}
        title="Group petitions"
        description="Analytics will show one bar (segments for each petition). Export downloads the group first."
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            {checkedList.map((p) => p.short_label || p.label).join(', ')}
          </p>
          <label className="block">
            <span className="label">Group name</span>
            <input
              className="input"
              value={groupLabel}
              onChange={(e) => setGroupLabel(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="label">Short label</span>
            <input
              className="input"
              value={groupShort}
              onChange={(e) => setGroupShort(e.target.value)}
              maxLength={16}
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setGroupOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !groupLabel.trim()}
              onClick={() => void createGroup()}
            >
              Create group
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function PetitionRow({
  p,
  nested,
  isAdmin,
  busy,
  checked,
  onToggle,
  onPatch,
  onDelete,
}: {
  p: Petition;
  nested: boolean;
  isAdmin: boolean;
  busy: boolean;
  checked: boolean;
  onToggle: () => void;
  onPatch: (p: Petition, next: Partial<Petition>) => void;
  onDelete: (p: Petition) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-1">
      {isAdmin ? (
        <input type="checkbox" checked={checked} onChange={onToggle} />
      ) : null}
      {isAdmin ? (
        <input
          className="input w-[5.5rem] py-1 text-sm"
          defaultValue={p.short_label}
          key={`s-${p.id}-${p.short_label}`}
          title="Short label"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== p.short_label) void onPatch(p, { short_label: v });
          }}
        />
      ) : (
        <span className="w-[5.5rem] truncate text-sm text-slate-600">
          {p.short_label}
        </span>
      )}
      <div className="min-w-[12rem] flex-1">
        {isAdmin ? (
          <input
            className="input py-1 text-sm"
            defaultValue={p.label}
            key={`l-${p.id}-${p.label}`}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== p.label) void onPatch(p, { label: v });
            }}
          />
        ) : (
          <span className="text-sm text-slate-800">{p.label}</span>
        )}
        {!nested ? (
          <div className="text-[11px] text-slate-400">{p.slug}</div>
        ) : null}
      </div>
      <label className="flex items-center gap-1 text-[11px] text-slate-500">
        <input
          type="checkbox"
          disabled={!isAdmin || busy}
          checked={p.is_default}
          onChange={() => void onPatch(p, { is_default: !p.is_default })}
        />
        Default
      </label>
      <label className="flex items-center gap-1 text-[11px] text-slate-500">
        <input
          type="checkbox"
          disabled={!isAdmin || busy}
          checked={p.is_active}
          onChange={() => void onPatch(p, { is_active: !p.is_active })}
        />
        Active
      </label>
      {isAdmin ? (
        <button
          type="button"
          className="text-xs font-medium text-rose-700 hover:underline"
          disabled={busy}
          onClick={() => void onDelete(p)}
        >
          Delete
        </button>
      ) : null}
    </div>
  );
}
