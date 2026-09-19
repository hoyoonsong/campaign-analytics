import { useMemo, useState } from 'react';

export type OverlapSet = {
  key: string;
  label: string;
  short_label: string;
  color: string;
};

export type OverlapCombo = {
  mask: number;
  count: number;
};

type Region = {
  mask: number;
  x: number;
  y: number;
  short: string;
};

type Props = {
  sets: OverlapSet[];
  combos?: OverlapCombo[] | null;
  onSelectCombo?: (mask: number) => void;
  title?: string;
  description?: string;
};

function fmt(n: number) {
  return Number(n || 0).toLocaleString();
}

function comboMap(combos?: OverlapCombo[] | null) {
  const map = new Map<number, number>();
  for (const c of combos ?? []) {
    map.set(Number(c.mask), Number(c.count) || 0);
  }
  return map;
}

function comboLabel(mask: number, sets: OverlapSet[]) {
  const hits = sets.filter((_, i) => (mask & (1 << i)) !== 0);
  if (!hits.length) return 'None';
  if (hits.length === sets.length && sets.length > 1) return 'All selected';
  return hits.map((s) => s.label).join(' + ');
}

export function OverlapVenn({
  sets,
  combos,
  onSelectCombo,
  title = 'Overlap',
  description,
}: Props) {
  const counts = useMemo(() => comboMap(combos), [combos]);
  const [hover, setHover] = useState<number | null>(null);
  const n = Math.min(sets.length, 3);
  const selected = sets.slice(0, n);

  const regions = useMemo<Region[]>(() => {
    if (n === 1) {
      return [{ mask: 1, x: 200, y: 180, short: selected[0].short_label }];
    }
    if (n === 2) {
      return [
        { mask: 1, x: 130, y: 180, short: selected[0].short_label },
        { mask: 2, x: 270, y: 180, short: selected[1].short_label },
        { mask: 3, x: 200, y: 180, short: 'Both' },
      ];
    }
    return [
      { mask: 1, x: 118, y: 118, short: selected[0].short_label },
      { mask: 2, x: 282, y: 118, short: selected[1].short_label },
      { mask: 4, x: 200, y: 290, short: selected[2].short_label },
      { mask: 3, x: 200, y: 108, short: `${selected[0].short_label}+${selected[1].short_label}` },
      { mask: 5, x: 138, y: 208, short: `${selected[0].short_label}+${selected[2].short_label}` },
      { mask: 6, x: 262, y: 208, short: `${selected[1].short_label}+${selected[2].short_label}` },
      { mask: 7, x: 200, y: 178, short: 'All 3' },
    ];
  }, [n, selected]);

  const total = useMemo(
    () => regions.reduce((sum, r) => sum + (counts.get(r.mask) ?? 0), 0),
    [counts, regions],
  );

  if (!n) {
    return <p className="text-sm text-slate-500">Select at least one set to compare.</p>;
  }

  return (
    <div className="space-y-2">
      <div>
        {title ? <h3 className="text-sm font-semibold text-slate-800">{title}</h3> : null}
        <p className={title ? 'mt-0.5 text-xs text-slate-500' : 'text-xs text-slate-500'}>
          {description ??
            (onSelectCombo
              ? 'Click a region to open that list in Search.'
              : 'People in each exclusive combination.')}
          {total > 0 ? (
            <>
              {' '}
              <span className="text-slate-600">{fmt(total)} in the diagram.</span>
            </>
          ) : null}
        </p>
      </div>

      <div className="mx-auto w-full max-w-sm">
        <svg
          viewBox="0 0 400 360"
          className="h-auto w-full"
          role="img"
          aria-label={title}
        >
          {n === 1 ? (
            <circle
              cx="200"
              cy="180"
              r="120"
              fill={`${selected[0].color}59`}
              stroke={selected[0].color}
              strokeWidth="2"
            />
          ) : n === 2 ? (
            <>
              <circle
                cx="150"
                cy="180"
                r="110"
                fill={`${selected[0].color}59`}
                stroke={selected[0].color}
                strokeWidth="2"
              />
              <circle
                cx="250"
                cy="180"
                r="110"
                fill={`${selected[1].color}59`}
                stroke={selected[1].color}
                strokeWidth="2"
              />
            </>
          ) : (
            <>
              <circle
                cx="150"
                cy="140"
                r="110"
                fill={`${selected[0].color}59`}
                stroke={selected[0].color}
                strokeWidth="2"
              />
              <circle
                cx="250"
                cy="140"
                r="110"
                fill={`${selected[1].color}59`}
                stroke={selected[1].color}
                strokeWidth="2"
              />
              <circle
                cx="200"
                cy="230"
                r="110"
                fill={`${selected[2].color}59`}
                stroke={selected[2].color}
                strokeWidth="2"
              />
            </>
          )}

          {selected.map((s, i) => {
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
                key={s.key}
                x={pos.x}
                y={pos.y}
                textAnchor="middle"
                className="fill-slate-700"
                style={{ fontSize: 12, fontWeight: 600 }}
              >
                {s.label}
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
                <circle cx={region.x} cy={region.y} r={28} fill="transparent" />
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

      {hover != null ? (
        <p className="text-center text-xs font-medium text-slate-600">
          {comboLabel(hover, selected)}: {fmt(counts.get(hover) ?? 0)}
        </p>
      ) : (
        <p className="text-center text-xs text-slate-400">&nbsp;</p>
      )}
    </div>
  );
}
