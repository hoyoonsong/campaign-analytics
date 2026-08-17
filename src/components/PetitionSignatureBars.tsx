import {
  segmentShade,
  unionCountForPetitions,
  type PetitionUnit,
} from '../lib/petitions';
import type { PetitionComboCount } from '../lib/types';

type Props = {
  units: PetitionUnit[];
  combos?: PetitionComboCount[] | null;
  countsBySlug: Map<string, number>;
  totalVoters: number;
  onSelectSlugs: (slugs: string[]) => void;
};

function fmt(n: number) {
  return Number(n || 0).toLocaleString();
}

export function PetitionSignatureBars({
  units,
  combos,
  countsBySlug,
  totalVoters,
  onSelectSlugs,
}: Props) {
  const rows = units.map((unit) => {
    const segments = unit.petitions.map((p, i) => ({
      petition: p,
      count: countsBySlug.get(p.slug) ?? 0,
      color: segmentShade(unit.colorBit, i, unit.petitions.length),
    }));
    const union = unionCountForPetitions(combos, unit.petitions);
    const rawSum = segments.reduce((s, seg) => s + seg.count, 0);
    return { unit, segments, union, rawSum };
  });
  const maxUnion = Math.max(0, ...rows.map((r) => r.union));

  return (
    <div className="space-y-1.5">
      {rows.map((row) => {
        const widthPct = maxUnion ? (100 * row.union) / maxUnion : 0;
        const pctOfAll = totalVoters ? (100 * row.union) / totalVoters : 0;
        const slugs = row.unit.petitions.map((p) => p.slug);
        return (
          <div key={row.unit.key} className="flex items-center gap-2">
            <button
              type="button"
              className="w-[5.5rem] shrink-0 truncate text-left text-[11px] text-slate-600 hover:underline"
              title={row.unit.label}
              onClick={() => onSelectSlugs(slugs)}
            >
              {row.unit.short_label || row.unit.label}
            </button>
            <div className="min-w-0 flex-1">
              <div
                className="flex h-4 overflow-hidden rounded-sm"
                style={{ width: `${Math.max(widthPct, row.union > 0 ? 6 : 0)}%` }}
              >
                {row.segments.map((seg) => {
                  const segPct = row.rawSum
                    ? (100 * seg.count) / row.rawSum
                    : 0;
                  return (
                    <button
                      key={seg.petition.slug}
                      type="button"
                      title={`${seg.petition.label}: ${fmt(seg.count)}`}
                      className="h-full min-w-[3px] border-r border-white last:border-r-0"
                      style={{
                        width: `${Math.max(segPct, seg.count > 0 ? 4 : 0)}%`,
                        background: seg.color,
                      }}
                      onClick={() => onSelectSlugs([seg.petition.slug])}
                    />
                  );
                })}
              </div>
            </div>
            <button
              type="button"
              className="w-[4.8rem] shrink-0 text-right text-[11px] font-semibold text-slate-800 hover:underline"
              title={`${row.unit.label}: ${fmt(row.union)} unique (${pctOfAll.toFixed(1)}%)`}
              onClick={() => onSelectSlugs(slugs)}
            >
              {fmt(row.union)}
            </button>
          </div>
        );
      })}
    </div>
  );
}
