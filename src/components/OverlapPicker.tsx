import { useEffect, useRef, useState } from 'react';

export type OverlapPickerUnit = {
  key: string;
  label: string;
  grouped: boolean;
  children: { slug: string; label: string }[];
};

type Props = {
  units: OverlapPickerUnit[];
  selectedSlugs: string[];
  totalCount: number;
  noun?: string;
  onChange: (slugs: string[]) => void;
  onSelectAll: () => void;
  onSelectDefaults?: () => void;
  maxSelected?: number;
};

export function OverlapPicker({
  units,
  selectedSlugs,
  totalCount,
  noun = 'Elections',
  onChange,
  onSelectAll,
  onSelectDefaults,
  maxSelected,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const toggleSlug = (slug: string) => {
    if (selectedSlugs.includes(slug)) {
      const next = selectedSlugs.filter((s) => s !== slug);
      if (next.length) onChange(next);
    } else if (!maxSelected || selectedSlugs.length < maxSelected) {
      onChange([...selectedSlugs, slug]);
    }
  };

  const toggleUnit = (slugs: string[]) => {
    const allOn = slugs.every((s) => selectedSlugs.includes(s));
    if (allOn) {
      const drop = new Set(slugs);
      const next = selectedSlugs.filter((s) => !drop.has(s));
      if (next.length) onChange(next);
      return;
    }
    const next = [...new Set([...selectedSlugs, ...slugs])];
    onChange(maxSelected ? next.slice(0, maxSelected) : next);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className="btn-secondary px-2.5 py-1 text-xs"
        onClick={() => setOpen((v) => !v)}
      >
        {noun}: {selectedSlugs.length} of {totalCount}
      </button>
      {open ? (
        <div className="absolute right-0 z-30 mt-1 w-72 rounded-md border border-slate-200 bg-white p-2 shadow-lg">
          <div className="mb-1.5 flex gap-2">
            <button
              type="button"
              className="text-[11px] font-medium text-brand-700 hover:underline"
              onClick={onSelectAll}
            >
              Select all
            </button>
            {onSelectDefaults ? (
              <button
                type="button"
                className="text-[11px] font-medium text-slate-500 hover:underline"
                onClick={onSelectDefaults}
              >
                Defaults
              </button>
            ) : null}
          </div>
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {units.map((unit) => {
              const slugs = unit.children.map((c) => c.slug);
              const selectedCount = slugs.filter((s) => selectedSlugs.includes(s)).length;
              const allOn = selectedCount === slugs.length && slugs.length > 0;
              const someOn = selectedCount > 0 && !allOn;
              return (
                <li key={unit.key}>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={allOn}
                      ref={(el) => {
                        if (el) el.indeterminate = someOn;
                      }}
                      onChange={() => toggleUnit(slugs)}
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span className="truncate font-medium">{unit.label}</span>
                  </label>
                  {unit.grouped && unit.children.length > 1 ? (
                    <ul className="ml-6 mt-0.5 space-y-0.5">
                      {unit.children.map((c) => (
                        <li key={c.slug}>
                          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-600">
                            <input
                              type="checkbox"
                              checked={selectedSlugs.includes(c.slug)}
                              onChange={() => toggleSlug(c.slug)}
                              className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                            />
                            <span className="truncate">{c.label}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
