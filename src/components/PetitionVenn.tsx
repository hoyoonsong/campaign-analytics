import { useMemo, useState } from 'react';
import {
  PETITION_COMBOS,
  type PetitionVennCounts,
  type PetitionVennKey,
  normalizePetitionVenn,
} from '../lib/petitionCombos';

const COLORS = {
  op: 'rgba(29, 78, 216, 0.35)',
  rf: 'rgba(15, 118, 110, 0.35)',
  mmj: 'rgba(180, 83, 9, 0.35)',
  opStroke: '#1d4ed8',
  rfStroke: '#0f766e',
  mmjStroke: '#b45309',
};

const REGION_POS: Record<PetitionVennKey, { x: number; y: number }> = {
  op_only: { x: 118, y: 118 },
  rf_only: { x: 282, y: 118 },
  mmj_only: { x: 200, y: 290 },
  op_rf: { x: 200, y: 108 },
  op_mmj: { x: 138, y: 208 },
  rf_mmj: { x: 262, y: 208 },
  all_three: { x: 200, y: 178 },
};

type Props = {
  counts?: Partial<PetitionVennCounts> | null;
  /** Click a Venn region (e.g. open Search with that exclusive segment). */
  onSelectSegment?: (key: PetitionVennKey) => void;
  compact?: boolean;
};

function fmt(n: number) {
  return Number(n || 0).toLocaleString();
}

export function PetitionVenn({
  counts: rawCounts,
  onSelectSegment,
  compact = false,
}: Props) {
  const counts = useMemo(() => normalizePetitionVenn(rawCounts), [rawCounts]);
  const [hover, setHover] = useState<PetitionVennKey | null>(null);

  const totalSigned = useMemo(
    () => PETITION_COMBOS.reduce((sum, c) => sum + (counts[c.key] ?? 0), 0),
    [counts],
  );

  const hoverLabel = hover
    ? PETITION_COMBOS.find((c) => c.key === hover)?.label
    : null;

  return (
    <div className={compact ? 'space-y-1' : 'space-y-2'}>
      {!compact ? (
        <div>
          <h3 className="text-sm font-semibold text-slate-800">
            Petition combinations
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Exclusive OP · RF · MMJ (Achilles ignored). Click a region to open
            that list in Search.
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
          <circle
            cx="150"
            cy="140"
            r="110"
            fill={COLORS.op}
            stroke={COLORS.opStroke}
            strokeWidth="2"
          />
          <circle
            cx="250"
            cy="140"
            r="110"
            fill={COLORS.rf}
            stroke={COLORS.rfStroke}
            strokeWidth="2"
          />
          <circle
            cx="200"
            cy="230"
            r="110"
            fill={COLORS.mmj}
            stroke={COLORS.mmjStroke}
            strokeWidth="2"
          />

          <text
            x="70"
            y="48"
            textAnchor="middle"
            className="fill-slate-700"
            style={{ fontSize: 12, fontWeight: 600 }}
          >
            Open Primaries
          </text>
          <text
            x="330"
            y="48"
            textAnchor="middle"
            className="fill-slate-700"
            style={{ fontSize: 12, fontWeight: 600 }}
          >
            Reproductive Freedom
          </text>
          <text
            x="200"
            y="348"
            textAnchor="middle"
            className="fill-slate-700"
            style={{ fontSize: 12, fontWeight: 600 }}
          >
            Medical Marijuana
          </text>

          {PETITION_COMBOS.map((combo) => {
            const pos = REGION_POS[combo.key];
            const active = hover === combo.key;
            return (
              <g
                key={combo.key}
                className={onSelectSegment ? 'cursor-pointer' : undefined}
                onMouseEnter={() => setHover(combo.key)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onSelectSegment?.(combo.key)}
              >
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={28}
                  fill="transparent"
                  stroke="none"
                />
                <text
                  x={pos.x}
                  y={pos.y - 6}
                  textAnchor="middle"
                  style={{
                    fontSize: 11,
                    fontWeight: active ? 700 : 600,
                    fill: active ? '#0f172a' : '#334155',
                  }}
                >
                  {combo.shortLabel}
                </text>
                <text
                  x={pos.x}
                  y={pos.y + 12}
                  textAnchor="middle"
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    fill: '#0f172a',
                  }}
                >
                  {fmt(counts[combo.key])}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {hoverLabel ? (
        <p className="text-center text-xs font-medium text-slate-600">
          {hoverLabel}: {fmt(counts[hover!])}
        </p>
      ) : (
        <p className="text-center text-xs text-slate-400">&nbsp;</p>
      )}
    </div>
  );
}
