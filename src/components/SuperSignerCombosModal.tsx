import { useEffect, useMemo, useState } from 'react';
import { Modal } from './ui';
import {
  bitCount,
  colorForBit,
  comboLabel,
  petitionsInMask,
  type Petition,
} from '../lib/petitions';
import type { PetitionComboCount } from '../lib/types';

type ComboRow = { mask: number; count: number; n: number };

type Props = {
  open: boolean;
  onClose: () => void;
  petitions: Petition[];
  combos?: PetitionComboCount[] | null;
  /** Open focused on this petition-count (2, 3, …). Null = all super signers. */
  initialCount?: number | null;
  onSelectCombo?: (mask: number) => void;
};

function fmt(n: number) {
  return Number(n || 0).toLocaleString();
}

export function SuperSignerCombosModal({
  open,
  onClose,
  petitions,
  combos,
  initialCount = null,
  onSelectCombo,
}: Props) {
  const [filter, setFilter] = useState<number | null>(initialCount ?? null);

  useEffect(() => {
    if (open) setFilter(initialCount ?? null);
  }, [open, initialCount]);

  const { rows, counts, total } = useMemo(() => {
    const rows: ComboRow[] = [...(combos ?? [])]
      .map((c) => ({
        mask: Number(c.mask),
        count: Number(c.count) || 0,
        n: bitCount(Number(c.mask)),
      }))
      .filter((c) => c.count > 0 && c.n >= 2)
      .sort((a, b) => b.count - a.count || a.mask - b.mask);

    const counts = [...new Set(rows.map((r) => r.n))].sort((a, b) => a - b);
    const total = rows.reduce((s, r) => s + r.count, 0);
    return { rows, counts, total };
  }, [combos]);

  const visible = filter == null ? rows : rows.filter((r) => r.n === filter);
  const visibleTotal = visible.reduce((s, r) => s + r.count, 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Super signer combinations"
      description="Exclusive lists — each person appears in one row. Click a combination to open it in Search."
    >
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <FilterChip
          active={filter == null}
          onClick={() => setFilter(null)}
          label={`All ${fmt(total)}`}
        />
        {counts.map((n) => (
          <FilterChip
            key={n}
            active={filter === n}
            onClick={() => setFilter(n)}
            label={`${n}`}
          />
        ))}
      </div>

      <p className="mb-2 text-xs text-slate-500">
        {filter == null
          ? `${fmt(visible.length)} combinations`
          : `${fmt(visibleTotal)} people signed exactly ${filter} petitions · ${fmt(visible.length)} combinations`}
      </p>

      <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
        {visible.map((row) => {
          const members = petitionsInMask(row.mask, petitions);
          return (
            <li key={row.mask}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50"
                onClick={() => {
                  onSelectCombo?.(row.mask);
                  onClose();
                }}
              >
                <span className="flex h-3 min-w-[2.5rem] overflow-hidden rounded-sm">
                  {members.map((p) => (
                    <span
                      key={p.slug}
                      className="h-full min-w-[6px] flex-1"
                      style={{ background: colorForBit(p.bit_index) }}
                    />
                  ))}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-800">
                    {comboLabel(row.mask, petitions)}
                  </span>
                  <span className="block text-[11px] text-slate-500">
                    {row.n} petitions
                  </span>
                </span>
                <span className="shrink-0 text-sm font-semibold text-slate-900">
                  {fmt(row.count)}
                </span>
              </button>
            </li>
          );
        })}
        {visible.length === 0 ? (
          <li className="px-3 py-6 text-center text-sm text-slate-400">
            No combinations in this group.
          </li>
        ) : null}
      </ul>
    </Modal>
  );
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-[11px] font-semibold ${
        active
          ? 'bg-slate-800 text-white'
          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
      }`}
    >
      {label}
    </button>
  );
}
