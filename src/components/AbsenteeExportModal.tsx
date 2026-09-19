import { useState } from 'react';
import {
  absenteeComboLabel,
  type AbsenteeComboCount,
  type AbsenteeElection,
  type AbsenteeUnit,
} from '../lib/absentee';
import { EXPORT_FILE_ROWS } from '../lib/exportVotersCsv';
import { Modal } from './ui';

type Props = {
  open: boolean;
  onClose: () => void;
  groupUnits: AbsenteeUnit[];
  comboUnits: AbsenteeUnit[];
  combos?: AbsenteeComboCount[] | null;
  exportingKey?: string | number | null;
  exportingAll?: boolean;
  exportingProgress?: string | null;
  onExportUnit: (unit: AbsenteeUnit) => void;
  onExportElection: (election: AbsenteeElection) => void;
  onExportSegment: (mask: number) => void;
  onExportAll: () => void;
  onExportSuper?: () => void;
  superCount?: number;
};

export function AbsenteeExportModal({
  open,
  onClose,
  groupUnits,
  comboUnits,
  combos,
  exportingKey,
  exportingAll,
  exportingProgress,
  onExportUnit,
  onExportElection,
  onExportSegment,
  onExportAll,
  onExportSuper,
  superCount = 0,
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
      title="Export absentee lists"
      description="Download a year group as one CSV (anyone on file in at least one of those elections). Open a group for the individual races. Exclusive combinations match the Groups / Each election tab. Large lists split into 20,000-row files with a pause between them — you still get every person."
      wide
    >
      {exportingProgress ? (
        <p className="mb-3 text-xs font-medium text-slate-600">
          Exporting… {exportingProgress}
        </p>
      ) : null}
      <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
        {groupUnits.map((unit) => {
          const grouped = unit.elections.length > 1;
          const expanded = openKeys.has(unit.key);
          const exportingUnit = exportingKey === unit.key;
          return (
            <li key={unit.key}>
              <div className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-800">
                    {unit.label}
                    {grouped ? (
                      <span className="ml-1.5 text-[11px] font-normal text-slate-500">
                        {unit.elections.length} elections
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-slate-500">{unit.short_label}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {grouped ? (
                    <button
                      type="button"
                      className="text-xs font-medium text-brand-700 hover:underline"
                      onClick={() => toggle(unit.key)}
                    >
                      {expanded ? 'Hide elections' : 'Show elections'}
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
                  {unit.elections.map((e) => {
                    const key = `e:${e.slug}`;
                    return (
                      <li
                        key={e.slug}
                        className="flex items-center gap-3 px-3 py-2 pl-8"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                          {e.short_label || e.label}
                        </span>
                        <button
                          type="button"
                          className="btn-secondary px-2.5 py-1 text-xs"
                          disabled={busy}
                          onClick={() => onExportElection(e)}
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
            <div className="mb-2 flex items-center gap-3">
              <p className="min-w-0 flex-1 text-xs text-slate-500">
                {total.toLocaleString()} people in exclusive combo slices
                {total > EXPORT_FILE_ROWS
                  ? ` · lists over ${EXPORT_FILE_ROWS.toLocaleString()} split into files`
                  : ''}
                .
              </p>
              <button
                type="button"
                className="btn-secondary shrink-0 text-xs"
                disabled={busy || total === 0}
                onClick={() => onExportAll()}
              >
                {exportingAll
                  ? 'Exporting all…'
                  : `Export all ${rows.length} CSVs`}
              </button>
            </div>
            <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
              {onExportSuper && comboUnits.length >= 2 ? (
                <li className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-800">
                      All combinations
                    </div>
                    <div className="text-xs text-slate-500">
                      {superCount.toLocaleString()} people in 2 or more
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-secondary shrink-0 text-xs"
                    disabled={busy || superCount === 0}
                    onClick={() => onExportSuper()}
                  >
                    {exportingKey === 'all-combos' ? 'Exporting…' : 'Export CSV'}
                  </button>
                </li>
              ) : null}
              {rows.map((row) => {
                const exporting = exportingKey === row.mask;
                return (
                  <li key={row.mask} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-800">
                        {absenteeComboLabel(row.mask, comboUnits)}
                      </div>
                      <div className="text-xs text-slate-500">
                        {row.count.toLocaleString()} people
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary shrink-0 text-xs"
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
