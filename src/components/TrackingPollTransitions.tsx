import { useMemo, useState } from 'react';
import {
  PREF_LABELS,
  PREF_ORDER,
  type PrefBucket,
  type TransitionFlow,
  type TransitionView,
} from '../lib/trackingPoll';

const TODD = '#6d28d9';
const RISCH = '#dc2626';
const UNSURE = '#ca8a04';

const COLORS: Record<PrefBucket, string> = {
  todd: TODD,
  risch: RISCH,
  unsure: UNSURE,
};

type Node = {
  key: PrefBucket;
  y: number;
  h: number;
  count: number;
};

function layoutNodes(
  counts: Record<PrefBucket, number>,
  n: number,
  height: number,
): Node[] {
  const gap = 14;
  const pad = 10;
  const minH = 22;
  const present = PREF_ORDER.filter((k) => counts[k] > 0);
  if (present.length === 0) return [];
  const usable = Math.max(
    height - pad * 2 - gap * (present.length - 1),
    present.length * minH,
  );
  const raw = present.map((key) =>
    n > 0 ? (counts[key] / n) * usable : usable / present.length,
  );
  const lifted = raw.map((h) => Math.max(h, minH));
  const extra = lifted.reduce((s, h) => s + h, 0) - usable;
  const heights =
    extra <= 0
      ? lifted
      : lifted.map((h) => {
          const shrinkable = h - minH;
          const share =
            lifted.reduce((s, x) => s + Math.max(0, x - minH), 0) || 1;
          return h - (shrinkable / share) * extra;
        });
  let y = pad;
  return present.map((key, i) => {
    const h = heights[i];
    const node = { key, y, h, count: counts[key] };
    y += h + gap;
    return node;
  });
}

function bandPath(
  x0: number,
  y0: number,
  h0: number,
  x1: number,
  y1: number,
  h1: number,
): string {
  const mx = (x0 + x1) / 2;
  return [
    `M ${x0} ${y0}`,
    `C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1}`,
    `L ${x1} ${y1 + h1}`,
    `C ${mx} ${y1 + h1}, ${mx} ${y0 + h0}, ${x0} ${y0 + h0}`,
    'Z',
  ].join(' ');
}

function movementHint(flow: TransitionFlow): string {
  if (flow.same) {
    if (flow.from === 'risch') return 'Same — skip';
    if (flow.from === 'todd') return 'Same — already with us';
    return 'Same both times';
  }
  if (flow.movement === 'toward') return 'Toward Achilles';
  if (flow.movement === 'away') return 'Away from Achilles';
  return 'Changed';
}

export function TrackingPollTransitions({
  data,
  leftLabel,
  rightLabel,
  empty,
}: {
  data: TransitionView;
  leftLabel: string;
  rightLabel: string;
  empty: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const height = 280;
  const leftX = 118;
  const rightX = 520;
  const nodeW = 16;

  const chart = useMemo(() => {
    const left = layoutNodes(data.first, data.n, height);
    const right = layoutNodes(data.second, data.n, height);
    const leftUsed: Record<string, number> = {};
    const rightUsed: Record<string, number> = {};
    const links = data.flows
      .filter((f) => f.count > 0)
      .map((flow) => {
        const L = left.find((n) => n.key === flow.from);
        const R = right.find((n) => n.key === flow.to);
        if (!L || !R || !data.n) return null;
        const lh = Math.max((flow.count / Math.max(L.count, 1)) * L.h, 3);
        const rh = Math.max((flow.count / Math.max(R.count, 1)) * R.h, 3);
        const ly = L.y + (leftUsed[flow.from] ?? 0);
        const ry = R.y + (rightUsed[flow.to] ?? 0);
        leftUsed[flow.from] = (leftUsed[flow.from] ?? 0) + lh;
        rightUsed[flow.to] = (rightUsed[flow.to] ?? 0) + rh;
        return { flow, ly, lh, ry, rh };
      })
      .filter((v): v is NonNullable<typeof v> => v != null);
    const bottom = Math.max(
      height,
      ...left.map((n) => n.y + n.h),
      ...right.map((n) => n.y + n.h),
      ...links.map((l) => l.ly + l.lh),
      ...links.map((l) => l.ry + l.rh),
    );
    return { left, right, links, height: bottom + 10 };
  }, [data, height]);

  if (data.n === 0) {
    return (
      <p className="py-10 text-center text-sm text-slate-500">{empty}</p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <div className="relative mx-auto mb-1 h-4 max-w-3xl text-[11px] font-medium uppercase tracking-wide text-slate-500">
          <span className="absolute left-[18%] -translate-x-1/2">{leftLabel}</span>
          <span className="absolute left-[82%] -translate-x-1/2">{rightLabel}</span>
        </div>
        <svg
          viewBox={`0 0 640 ${chart.height}`}
          className="mx-auto block h-72 w-full max-w-3xl overflow-visible"
          role="img"
          aria-label={`${leftLabel} to ${rightLabel} preference flow`}
        >
          {chart.links.map(({ flow, ly, lh, ry, rh }) => {
            const id = `${flow.from}>${flow.to}`;
            const active = hover == null || hover === id;
            return (
              <path
                key={id}
                d={bandPath(leftX + nodeW, ly, lh, rightX, ry, rh)}
                fill={COLORS[flow.from]}
                fillOpacity={active ? (flow.same ? 0.22 : 0.38) : 0.06}
                className="cursor-pointer"
                onMouseEnter={() => setHover(id)}
                onMouseLeave={() => setHover(null)}
              >
                <title>
                  {PREF_LABELS[flow.from]} → {PREF_LABELS[flow.to]}:{' '}
                  {flow.count.toLocaleString()}
                </title>
              </path>
            );
          })}
          {chart.left.map((n) => (
            <g key={`l-${n.key}`}>
              <rect
                x={leftX}
                y={n.y}
                width={nodeW}
                height={n.h}
                rx={3}
                fill={COLORS[n.key]}
              />
              <text
                x={leftX - 8}
                y={n.y + n.h / 2}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-slate-700"
                fontSize="11"
              >
                {PREF_LABELS[n.key]} {n.count.toLocaleString()}
              </text>
            </g>
          ))}
          {chart.right.map((n) => (
            <g key={`r-${n.key}`}>
              <rect
                x={rightX}
                y={n.y}
                width={nodeW}
                height={n.h}
                rx={3}
                fill={COLORS[n.key]}
              />
              <text
                x={rightX + nodeW + 8}
                y={n.y + n.h / 2}
                textAnchor="start"
                dominantBaseline="middle"
                className="fill-slate-700"
                fontSize="11"
              >
                {PREF_LABELS[n.key]} {n.count.toLocaleString()}
              </text>
            </g>
          ))}
        </svg>
      </div>

      <ul className="divide-y divide-slate-100">
        {data.flows.map((flow) => {
          const id = `${flow.from}>${flow.to}`;
          const pct = data.n ? (100 * flow.count) / data.n : 0;
          return (
            <li
              key={id}
              className={`flex items-center gap-3 py-1.5 text-sm ${
                hover === id ? 'bg-slate-50' : ''
              }`}
              onMouseEnter={() => setHover(id)}
              onMouseLeave={() => setHover(null)}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: COLORS[flow.from] }}
              />
              <span className="min-w-0 flex-1 text-slate-700">
                {PREF_LABELS[flow.from]}
                <span className="px-1.5 text-slate-400">→</span>
                {PREF_LABELS[flow.to]}
                <span className="ml-2 text-[11px] text-slate-500">
                  {movementHint(flow)}
                </span>
              </span>
              <span className="w-28">
                <span className="block h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${pct}%`,
                      background: COLORS[flow.to],
                    }}
                  />
                </span>
              </span>
              <span className="w-16 text-right tabular-nums text-slate-800">
                {flow.count.toLocaleString()}
              </span>
              <span className="w-12 text-right tabular-nums text-[11px] text-slate-500">
                {pct.toFixed(0)}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
