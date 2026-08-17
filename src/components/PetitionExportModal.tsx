import { useState } from 'react';
import { Modal } from './ui';
import {
  comboLabel,
  type Petition,
  type PetitionUnit,
} from '../lib/petitions';
import type { PetitionComboCount } from '../lib/types';

type Props = {
  open: boolean;
  onClose: () => void;
  units: PetitionUnit[];
  petitions: Petition[];
  combos?: PetitionComboCount[] | null;
  exportingKey?: string | number | null;
  exportingAll?: boolean;
  onExportUnit: (unit: PetitionUnit) => void;
  onExportPetition: (petition: Petition) => void;
  onExportSegment: (mask: number) => void;
  onExportAll: () => void;
};

export function PetitionExportModal({
  open,
  onClose,
  units,
  petitions,
  combos,
  exportingKey,
  exportingAll,
  onExportUnit,
  onExportPetition,
  onExportSegment,
  onExportAll,
}: Props) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set());
  const [combosOpen, setCombosOpen] = useState(false);

  const rows = [...(combos ?? [])]
    .map((c) => ({ mask: Number(c.mask), count: Number(c.count) || 0 }))
    .filter((c) => c.count > 0 && c.mask !== 0)
    .sort((a, b) => b.count - a.count || a.mask - b.mask);
  const busy = !!exportingAll || exportingKey != null;
  const total = rows.reduce((s, c) => s + c.count, 0);

  const toggle = (key: string) => {
    setOpenKeys((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Export petition lists"
      description="Download a group as one CSV (anyone who signed at least one). Open a group for the individual petitions."
      wide
    >
      <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
        {units.map((unit) => {
          const grouped = !!unit.group && unit.petitions.length > 1;
          const expanded = openKeys.has(unit.key);
          const exportingUnit = exportingKey === unit.key;
          return (
            <li key={unit.key}>
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800">
                    {unit.label}
                    {grouped ? (
                      <span className="ml-1.5 text-[11px] font-normal text-slate-500">
                        {unit.petitions.length} petitions
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-slate-500">
                    {unit.short_label}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {grouped ? (
                    <button
                      type="button"
                      className="text-xs font-medium text-brand-700 hover:underline"
                      onClick={() => toggle(unit.key)}
                    >
                      {expanded ? 'Hide petitions' : 'Show petitions'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn-primary px-3 py-1.5 text-xs"
                    disabled={busy}
                    onClick={() => onExportUnit(unit)}
                  >
                    {exportingUnit ? 'Exporting…' : 'Export CSV'}
                  </button>
                </div>
              </div>
              {grouped && expanded ? (
                <ul className="border-t border-slate-100 bg-slate-50/70">
                  {unit.petitions.map((p) => {
                    const key = `p:${p.slug}`;
                    return (
                      <li
                        key={p.slug}
                        className="flex items-center justify-between gap-2 px-3 py-2 pl-8"
                      >
                        <span className="min-w-0 truncate text-sm text-slate-700">
                          {p.short_label || p.label}
                        </span>
                        <button
                          type="button"
                          className="btn-secondary px-2.5 py-1 text-xs"
                          disabled={busy}
                          onClick={() => onExportPetition(p)}
                        >
                          {exportingKey === key ? 'Exporting…' : 'Export'}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="mt-4">
        <button
          type="button"
          className="mb-2 text-xs font-medium text-slate-600 hover:underline"
          onClick={() => setCombosOpen((v) => !v)}
        >
          {combosOpen ? 'Hide' : 'Show'} exclusive combinations ({rows.length})
        </button>
        {combosOpen ? (
          <>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-500">
                {total.toLocaleString()} people in exclusive combo slices.
              </p>
              <button
                type="button"
                className="btn-secondary text-xs"
                disabled={busy || total === 0}
                onClick={() => onExportAll()}
              >
                {exportingAll
                  ? 'Exporting all…'
                  : `Export all ${rows.length} CSVs`}
              </button>
            </div>
            <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
              {rows.map((row) => {
                const exporting = exportingKey === row.mask;
                return (
                  <li
                    key={row.mask}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-800">
                        {comboLabel(row.mask, petitions)}
                      </div>
                      <div className="text-xs text-slate-500">
                        {row.count.toLocaleString()} people
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary text-xs"
                      disabled={busy || row.count === 0}
                      onClick={() => onExportSegment(row.mask)}
                    >
                      {exporting ? 'Exporting…' : 'Export CSV'}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
