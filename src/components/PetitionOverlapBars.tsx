import { useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { SuperSignerCombosModal } from "./SuperSignerCombosModal";
import {
  bitCount,
  bitValue,
  collapseCombosToUnits,
  exclusiveCountForMask,
  segmentShade,
  unitsAsVirtualPetitions,
  type Petition,
  type PetitionUnit,
} from "../lib/petitions";
import type { PetitionComboCount } from "../lib/types";

const PIE_COLORS = [
  "#0f766e",
  "#b45309",
  "#7c3aed",
  "#be123c",
  "#0369a1",
  "#4d7c0f",
  "#c2410c",
  "#4338ca",
  "#0e7490",
];

export type OverlapBarsCopy = {
  onlyOne?: string;
  multi?: string;
  multiEmpty?: string;
  modalTitle?: string;
  modalDescription?: string;
  itemNoun?: string;
  exactlyPhrase?: string;
};

type Props = {
  units: PetitionUnit[];
  combos?: PetitionComboCount[] | null;
  onSelectUnitCombo?: (unitMask: number) => void;
  onSelectPetitionExclusive?: (petition: Petition) => void;
  onSelectSuperSigners?: () => void;
  onExportCombo?: (mask: number, count: number) => void;
  copy?: OverlapBarsCopy;
};

function fmt(n: number) {
  return Number(n || 0).toLocaleString();
}

export function PetitionOverlapBars({
  units,
  combos,
  onSelectUnitCombo,
  onSelectPetitionExclusive,
  onSelectSuperSigners,
  onExportCombo,
  copy,
}: Props) {
  const onlyOne = copy?.onlyOne ?? 'Signed only one';
  const multi = copy?.multi ?? 'Super signers';
  const multiEmpty = copy?.multiEmpty ?? 'No overlapping signers.';
  const [comboOpen, setComboOpen] = useState(false);
  const [comboCount, setComboCount] = useState<number | null>(null);

  const openCombos = (n: number | null) => {
    setComboCount(n);
    setComboOpen(true);
  };

  const virtual = useMemo(() => unitsAsVirtualPetitions(units), [units]);
  const collapsed = useMemo(
    () => collapseCombosToUnits(combos, units),
    [combos, units],
  );

  const { onlys, superTotal, pie, maxOnly } = useMemo(() => {
    const byMask = new Map(
      collapsed.map((c) => [Number(c.mask), Number(c.count) || 0]),
    );
    const onlys = units.map((unit, i) => {
      const unitMask = 1 << i;
      const exclusiveMembers = unit.petitions.map((p) => ({
        petition: p,
        count: exclusiveCountForMask(combos, bitValue(p.bit_index)),
      }));
      const exclusiveSum = exclusiveMembers.reduce((s, m) => s + m.count, 0);
      const count = byMask.get(unitMask) ?? 0;
      return {
        unit,
        unitMask,
        count,
        exclusiveMembers,
        multiCount: Math.max(0, count - exclusiveSum),
      };
    });

    const byCount = new Map<number, number>();
    let superTotal = 0;
    for (const row of collapsed) {
      const n = bitCount(row.mask);
      if (n < 2) continue;
      superTotal += row.count;
      byCount.set(n, (byCount.get(n) ?? 0) + row.count);
    }

    const pie = [...byCount.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([n, count]) => ({
        key: n,
        name: n === 1 ? "1" : `${n}`,
        count,
      }));

    return {
      onlys,
      superTotal,
      pie,
      maxOnly: Math.max(0, ...onlys.map((r) => r.count)),
    };
  }, [collapsed, combos, units]);

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-xs font-medium text-slate-700">
          {onlyOne}
        </p>

        <div className="space-y-1.5">
          {onlys.map((row) => {
            const pct = maxOnly ? (100 * row.count) / maxOnly : 0;
            const grouped = row.unit.petitions.length > 1;
            const segs = grouped
              ? [
                  ...row.exclusiveMembers.map((m, i) => ({
                    key: m.petition.slug,
                    count: m.count,
                    label: m.petition.label,
                    short: m.petition.short_label,
                    color: segmentShade(
                      row.unit.colorBit,
                      i,
                      row.unit.petitions.length + (row.multiCount > 0 ? 1 : 0),
                    ),
                    onClick: () => onSelectPetitionExclusive?.(m.petition),
                  })),
                  ...(row.multiCount > 0
                    ? [
                        {
                          key: `${row.unit.key}-multi`,
                          count: row.multiCount,
                          label: `2+ of ${row.unit.short_label}`,
                          short: "2+",
                          color: segmentShade(
                            row.unit.colorBit,
                            row.unit.petitions.length,
                            row.unit.petitions.length + 1,
                          ),
                          onClick: () => onSelectUnitCombo?.(row.unitMask),
                        },
                      ]
                    : []),
                ]
              : [
                  {
                    key: row.unit.key,
                    count: row.count,
                    label: row.unit.label,
                    short: row.unit.short_label,
                    color: segmentShade(row.unit.colorBit, 0, 1),
                    onClick: () => onSelectUnitCombo?.(row.unitMask),
                  },
                ];
            const rawSum =
              segs.reduce((s, srow) => s + srow.count, 0) || row.count;
            return (
              <div key={row.unit.key} className="flex items-center gap-2">
                <button
                  type="button"
                  className="w-[5.5rem] shrink-0 truncate text-left text-[11px] text-slate-600 hover:underline"
                  title={row.unit.label}
                  onClick={() => onSelectUnitCombo?.(row.unitMask)}
                >
                  {row.unit.short_label || row.unit.label}
                </button>
                <div className="min-w-0 flex-1">
                  <div
                    className="flex h-4 overflow-hidden rounded-sm"
                    style={{
                      width: `${Math.max(pct, row.count > 0 ? 6 : 0)}%`,
                    }}
                  >
                    {segs.map((seg) => {
                      const segPct = rawSum ? (100 * seg.count) / rawSum : 0;
                      return (
                        <button
                          key={seg.key}
                          type="button"
                          title={`${seg.label}: ${fmt(seg.count)}`}
                          className="h-full min-w-[3px] border-r border-white last:border-r-0"
                          style={{
                            width: `${Math.max(segPct, seg.count > 0 ? 4 : 0)}%`,
                            background: seg.color,
                          }}
                          onClick={seg.onClick}
                        />
                      );
                    })}
                  </div>
                </div>
                <button
                  type="button"
                  className="w-[4.5rem] shrink-0 text-right text-[11px] font-semibold text-slate-800 hover:underline"
                  title={`${row.unit.label} only: ${fmt(row.count)}`}
                  onClick={() => onSelectUnitCombo?.(row.unitMask)}
                >
                  {fmt(row.count)}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {units.length >= 2 ? (
        <div>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <p className="text-xs font-medium text-slate-700">{multi}</p>
            {onSelectSuperSigners ? (
              <button
                type="button"
                className="text-xs font-semibold text-slate-900 hover:underline"
                onClick={onSelectSuperSigners}
              >
                {fmt(superTotal)}
              </button>
            ) : (
              <span className="text-xs font-semibold text-slate-900">
                {fmt(superTotal)}
              </span>
            )}
          </div>

          {superTotal > 0 && pie.length > 0 ? (
            <div className="flex items-center gap-3">
              <div className="h-36 w-36 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pie}
                      dataKey="count"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={38}
                      outerRadius={58}
                      paddingAngle={1.5}
                      stroke="none"
                      cursor="pointer"
                      onClick={(data) => {
                        const key = Number(
                          (data as { payload?: { key?: number } })?.payload
                            ?.key,
                        );
                        if (Number.isFinite(key) && key >= 2) openCombos(key);
                      }}
                    >
                      {pie.map((row, i) => (
                        <Cell
                          key={row.key}
                          fill={PIE_COLORS[i % PIE_COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value, name) => [
                        fmt(Number(value ?? 0)),
                        `${name} of these`,
                      ]}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="min-w-0 flex-1 space-y-1">
                {pie.map((row, i) => (
                  <li key={row.key}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 text-[11px] hover:underline"
                      onClick={() => openCombos(row.key)}
                    >
                      <span className="inline-flex min-w-0 items-center gap-1.5 text-slate-600">
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-sm"
                          style={{
                            background: PIE_COLORS[i % PIE_COLORS.length],
                          }}
                        />
                        {row.key} of these
                      </span>
                      <span className="shrink-0 font-semibold text-slate-800">
                        {fmt(row.count)}
                      </span>
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    className="pt-0.5 text-[11px] font-medium text-brand-700 hover:underline"
                    onClick={() => openCombos(null)}
                  >
                    All combinations
                  </button>
                </li>
              </ul>
            </div>
          ) : (
            <p className="text-[11px] text-slate-400">
              {multiEmpty}
            </p>
          )}
        </div>
      ) : null}

      <SuperSignerCombosModal
        open={comboOpen}
        onClose={() => setComboOpen(false)}
        petitions={virtual}
        combos={collapsed}
        initialCount={comboCount}
        onSelectCombo={onSelectUnitCombo}
        onExportCombo={onExportCombo}
        title={copy?.modalTitle}
        description={copy?.modalDescription}
        itemNoun={copy?.itemNoun}
        exactlyPhrase={copy?.exactlyPhrase}
      />
    </div>
  );
}
