import { Modal } from './ui';
import {
  PETITION_COMBOS,
  type PetitionVennCounts,
  type PetitionVennKey,
  normalizePetitionVenn,
} from '../lib/petitionCombos';

type Props = {
  open: boolean;
  onClose: () => void;
  counts?: Partial<PetitionVennCounts> | null;
  exportingKey?: PetitionVennKey | null;
  exportingAll?: boolean;
  onExportSegment: (key: PetitionVennKey) => void;
  onExportAll: () => void;
};

export function PetitionExportModal({
  open,
  onClose,
  counts: rawCounts,
  exportingKey,
  exportingAll,
  onExportSegment,
  onExportAll,
}: Props) {
  const counts = normalizePetitionVenn(rawCounts);
  const busy = exportingAll || exportingKey != null;
  const total = PETITION_COMBOS.reduce((s, c) => s + (counts[c.key] ?? 0), 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Export petition combinations"
      description="Exclusive OP × RF × MMJ segments (Achilles ignored). One CSV per bucket."
      wide
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">
          {total.toLocaleString()} people signed at least one.
        </p>
        <button
          type="button"
          className="btn-primary text-sm"
          disabled={busy || total === 0}
          onClick={() => onExportAll()}
        >
          {exportingAll ? 'Exporting all…' : 'Export all 7 CSVs'}
        </button>
      </div>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {PETITION_COMBOS.map((combo) => {
          const n = counts[combo.key] ?? 0;
          const exporting = exportingKey === combo.key;
          return (
            <li
              key={combo.key}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-800">
                  {combo.label}
                </div>
                <div className="text-xs text-slate-500">
                  {n.toLocaleString()} people
                </div>
              </div>
              <button
                type="button"
                className="btn-secondary text-xs"
                disabled={busy || n === 0}
                onClick={() => onExportSegment(combo.key)}
              >
                {exporting ? 'Exporting…' : 'Export CSV'}
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
