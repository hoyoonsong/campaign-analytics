import { useMemo, useState } from 'react';
import {
  colorForBit,
  comboCountMap,
  comboLabel,
  type Petition,
} from '../lib/petitions';
import type { PetitionComboCount } from '../lib/types';

type Props = {
  petitions: Petition[];
  combos?: PetitionComboCount[] | null;
  onSelectCombo?: (mask: number) => void;
  compact?: boolean;
};

function fmt(n: number) {
  return Number(n || 0).toLocaleString();
}

function bit(p: Petition) {
  return 2 ** p.bit_index;
}

export function PetitionVenn({
  petitions,
  combos,
  onSelectCombo,
  compact = false,
}: Props) {
  const counts = useMemo(() => comboCountMap(combos), [combos]);
  const [hover, setHover] = useState<number | null>(null);
  const n = Math.min(petitions.length, 3);
  const selected = petitions.slice(0, n);

  const regions = useMemo(() => {
    if (n === 1) {
      const m = bit(selected[0]);
      return [{ mask: m, x: 200, y: 180, short: selected[0].short_label }];
    }
    if (n === 2) {
      const a = bit(selected[0]);
      const b = bit(selected[1]);
      return [
        { mask: a, x: 130, y: 180, short: selected[0].short_label },
        { mask: b, x: 270, y: 180, short: selected[1].short_label },
        { mask: a | b, x: 200, y: 180, short: 'Both' },
      ];
    }
    const a = bit(selected[0]);
    const b = bit(selected[1]);
    const c = bit(selected[2]);
    return [
      { mask: a, x: 118, y: 118, short: selected[0].short_label },
      { mask: b, x: 282, y: 118, short: selected[1].short_label },
      { mask: c, x: 200, y: 290, short: selected[2].short_label },
      { mask: a | b, x: 200, y: 108, short: `${selected[0].short_label}+${selected[1].short_label}` },
      { mask: a | c, x: 138, y: 208, short: `${selected[0].short_label}+${selected[2].short_label}` },
      { mask: b | c, x: 262, y: 208, short: `${selected[1].short_label}+${selected[2].short_label}` },
      { mask: a | b | c, x: 200, y: 178, short: 'All 3' },
    ];
  }, [n, selected]);

  const totalSigned = useMemo(
    () => regions.reduce((sum, r) => sum + (counts.get(r.mask) ?? 0), 0),
    [counts, regions],
  );

  const hoverLabel =
    hover == null ? null : comboLabel(hover, selected);

  return (
    <div className={compact ? 'space-y-1' : 'space-y-2'}>
      {!compact ? (
        <div>
          <h3 className="text-sm font-semibold text-slate-800">
            Petition combinations
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Click a region to open that list in Search.
            {totalSigned > 0 ? (
              <>
                {' '}
                <span className="text-slate-600">
                  {fmt(totalSigned)} signed at least one.
                </span>
              </>
            ) : null}
          </p>
        </div>
      ) : (
        <p className="text-xs text-slate-500">
          Click a region to open that list in Search
          {totalSigned > 0 ? ` · ${fmt(totalSigned)} signed ≥1` : ''}.
        </p>
      )}

      <div className="mx-auto w-full max-w-sm">
        <svg
          viewBox="0 0 400 360"
          className="h-auto w-full"
          role="img"
          aria-label="Venn diagram of petition signature combinations"
        >
          {n === 1 ? (
            <circle
              cx="200"
              cy="180"
              r="120"
              fill={colorForBit(selected[0].bit_index) + '59'}
              stroke={colorForBit(selected[0].bit_index)}
              strokeWidth="2"
            />
          ) : n === 2 ? (
            <>
              <circle
                cx="150"
                cy="180"
                r="110"
                fill={colorForBit(selected[0].bit_index) + '59'}
                stroke={colorForBit(selected[0].bit_index)}
                strokeWidth="2"
              />
              <circle
                cx="250"
                cy="180"
                r="110"
                fill={colorForBit(selected[1].bit_index) + '59'}
                stroke={colorForBit(selected[1].bit_index)}
                strokeWidth="2"
              />
            </>
          ) : (
            <>
              <circle
                cx="150"
                cy="140"
                r="110"
                fill={colorForBit(selected[0].bit_index) + '59'}
                stroke={colorForBit(selected[0].bit_index)}
                strokeWidth="2"
              />
              <circle
                cx="250"
                cy="140"
                r="110"
                fill={colorForBit(selected[1].bit_index) + '59'}
                stroke={colorForBit(selected[1].bit_index)}
                strokeWidth="2"
              />
              <circle
                cx="200"
                cy="230"
                r="110"
                fill={colorForBit(selected[2].bit_index) + '59'}
                stroke={colorForBit(selected[2].bit_index)}
                strokeWidth="2"
              />
            </>
          )}

          {selected.map((p, i) => {
            const pos =
              n === 1
                ? { x: 200, y: 40 }
                : n === 2
                  ? [
                      { x: 80, y: 48 },
                      { x: 320, y: 48 },
                    ][i]
                  : [
                      { x: 70, y: 48 },
                      { x: 330, y: 48 },
                      { x: 200, y: 348 },
                    ][i];
            return (
              <text
                key={p.slug}
                x={pos.x}
                y={pos.y}
                textAnchor="middle"
                className="fill-slate-700"
                style={{ fontSize: 12, fontWeight: 600 }}
              >
                {p.label}
              </text>
            );
          })}

          {regions.map((region) => {
            const active = hover === region.mask;
            return (
              <g
                key={region.mask}
                className={onSelectCombo ? 'cursor-pointer' : undefined}
                onMouseEnter={() => setHover(region.mask)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onSelectCombo?.(region.mask)}
              >
                <circle
                  cx={region.x}
                  cy={region.y}
                  r={28}
                  fill="transparent"
                  stroke="none"
                />
                <text
                  x={region.x}
                  y={region.y - 6}
                  textAnchor="middle"
                  style={{
                    fontSize: 11,
                    fontWeight: active ? 700 : 600,
                    fill: active ? '#0f172a' : '#334155',
                  }}
                >
                  {region.short}
                </text>
                <text
                  x={region.x}
                  y={region.y + 12}
                  textAnchor="middle"
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    fill: '#0f172a',
                  }}
                >
                  {fmt(counts.get(region.mask) ?? 0)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {hoverLabel ? (
        <p className="text-center text-xs font-medium text-slate-600">
          {hoverLabel}: {fmt(counts.get(hover!) ?? 0)}
        </p>
      ) : (
        <p className="text-center text-xs text-slate-400">&nbsp;</p>
      )}
    </div>
  );
}
