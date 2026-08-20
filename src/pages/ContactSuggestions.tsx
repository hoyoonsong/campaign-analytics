import { useEffect, useState } from 'react';
import { Alert, PageHeader, Spinner } from '../components/ui';
import { VoterProfileModal } from '../components/VoterProfileModal';
import {
  fetchContactSuggestions,
  type ContactSuggestion,
  type ContactSuggestionsResult,
} from '../lib/api';
import { votersToCsv } from '../lib/csv';

type Slice = 'all' | 'republican' | 'democrat' | 'independent' | 'super';

const SLICES: { id: Slice; label: string; hint: string }[] = [
  { id: 'all', label: 'All', hint: 'Everyone who signed at least one petition and is not already supporter / maybe / opposed' },
  { id: 'republican', label: 'Republicans', hint: 'Republicans who signed petitions' },
  { id: 'democrat', label: 'Democrats', hint: 'Democrats who signed petitions' },
  { id: 'independent', label: 'Independents', hint: 'Unaffiliated / independent petition signers' },
  { id: 'super', label: '2+ petitions', hint: 'People who signed two or more' },
];

const PAGE_SIZE = 50;

export default function ContactSuggestions() {
  const [slice, setSlice] = useState<Slice>('all');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ContactSuggestionsResult | null>(null);
  const [profileId, setProfileId] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const party =
      slice === 'republican' || slice === 'democrat' || slice === 'independent'
        ? slice
        : null;
    const signedMin = slice === 'super' ? 2 : 1;
    void fetchContactSuggestions({
      party,
      signed_min: signedMin,
      page,
      page_size: PAGE_SIZE,
    })
      .then((res) => {
        if (!active) return;
        setData(res);
      })
      .catch((err: Error) => {
        if (!active) return;
        setData(null);
        setError(err.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [slice, page]);

  const counts = data?.counts ?? {};
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const countFor = (id: Slice) => {
    if (id === 'all') return counts.all ?? 0;
    if (id === 'super') return counts.super ?? 0;
    return counts[id] ?? 0;
  };

  const exportCsv = () => {
    const csv = votersToCsv(
      rows.map((r) => ({
        ...r,
        voter_id: null,
        status: null,
      })) as Record<string, unknown>[],
      [
        'first_name',
        'last_name',
        'petitions',
        'party',
        'email',
        'phone',
        'address_line_1',
        'city',
        'zip',
        'county',
      ],
    );
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contact-suggestions-${slice}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader
        title="Who to contact"
        description="Petition signers who are not already tagged supporter, maybe, or opposed — highest priority first."
        actions={
          <button
            type="button"
            className="btn-secondary"
            disabled={!rows.length}
            onClick={exportCsv}
          >
            Export this page
          </button>
        }
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {SLICES.map((s) => {
          const active = slice === s.id;
          return (
            <button
              key={s.id}
              type="button"
              title={s.hint}
              onClick={() => {
                setSlice(s.id);
                setPage(1);
              }}
              className={`card p-3 text-left transition ${
                active
                  ? 'border-brand-300 bg-brand-50/50'
                  : 'hover:border-brand-200 hover:bg-slate-50'
              }`}
            >
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                {s.label}
              </p>
              <p className="mt-0.5 text-2xl font-bold tabular-nums text-slate-900">
                {countFor(s.id).toLocaleString()}
              </p>
            </button>
          );
        })}
      </div>

      <p className="mb-3 text-[11px] text-slate-500">
        {SLICES.find((s) => s.id === slice)?.hint}. Ranked by number of petitions
        signed.
      </p>

      {error ? (
        <div className="mb-3">
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}

      {loading && !rows.length ? (
        <Spinner label="Loading people to contact…" />
      ) : rows.length === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-600">
          No untagged petition signers in this slice.
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Petitions</th>
                <th className="px-3 py-2 font-medium">Party</th>
                <th className="px-3 py-2 font-medium">Contact</th>
                <th className="px-3 py-2 font-medium">City</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <Row
                  key={r.id}
                  row={r}
                  onOpen={() => setProfileId(r.id)}
                />
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
            <span>
              {(total).toLocaleString()} people · page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-ghost px-2 py-1 text-xs"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn-ghost px-2 py-1 text-xs"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {profileId != null ? (
        <VoterProfileModal
          voterId={profileId}
          onClose={() => setProfileId(null)}
        />
      ) : null}
    </div>
  );
}

function Row({
  row,
  onOpen,
}: {
  row: ContactSuggestion;
  onOpen: () => void;
}) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || '—';
  const contact = [row.email, row.phone].filter(Boolean).join(' · ') || '—';
  return (
    <tr
      className="cursor-pointer hover:bg-slate-50"
      onClick={onOpen}
    >
      <td className="px-3 py-2 font-medium text-brand-700">{name}</td>
      <td className="px-3 py-2 tabular-nums text-slate-800">{row.petitions}</td>
      <td className="px-3 py-2 text-slate-600">{row.party || '—'}</td>
      <td className="px-3 py-2 text-slate-600">{contact}</td>
      <td className="px-3 py-2 text-slate-600">{row.city || '—'}</td>
    </tr>
  );
}
