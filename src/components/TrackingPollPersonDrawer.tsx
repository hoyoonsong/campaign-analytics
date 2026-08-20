import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { lookupTrackingPollVoters, linkTrackingPollResponse } from '../lib/api';
import {
  ANSWER_LABELS,
  MOVEMENT_COLORS,
  MOVEMENT_LABELS,
  formatPollDate,
  type PersonHistoryRow,
} from '../lib/trackingPoll';
import type { VoterHit } from '../lib/trackingPoll/match';
import { Alert, Spinner } from './ui';

export function TrackingPollPersonDrawer({
  person,
  responseId,
  isAdmin,
  onClose,
  onOpenVoter,
  onLinked,
}: {
  person: PersonHistoryRow;
  responseId: number | null;
  isAdmin: boolean;
  onClose: () => void;
  onOpenVoter?: (voterId: number) => void;
  onLinked: () => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<VoterHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await lookupTrackingPollVoters(q.trim());
      setHits(res.voters);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lookup failed');
    } finally {
      setBusy(false);
    }
  };

  const link = async (voterId: number) => {
    if (!responseId) return;
    setBusy(true);
    setError(null);
    try {
      await linkTrackingPollResponse(responseId, voterId);
      onLinked();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not link');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[4000] flex justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/40"
        aria-label="Close"
        onClick={onClose}
      />
      <aside className="relative z-10 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-slate-200 bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              {person.name || 'Respondent'}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {person.matched ? 'Matched to campaign profile' : 'Unmatched poll respondent'}
            </p>
          </div>
          <button type="button" className="btn-ghost px-2 py-1 text-sm" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          {error ? <Alert variant="error">{error}</Alert> : null}

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Contact
            </h3>
            <dl className="mt-2 space-y-1.5 text-sm">
              <Row label="Name" value={person.name} />
              <Row label="Phone" value={person.phone} />
              <Row label="Email" value={person.email} />
              <Row label="Profile ID" value={person.profile_id} />
            </dl>
            {person.voter_id && onOpenVoter ? (
              <button
                type="button"
                className="btn-secondary mt-3 text-xs"
                onClick={() => onOpenVoter(person.voter_id!)}
              >
                Open voter profile
              </button>
            ) : null}
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Poll history
            </h3>
            <ol className="mt-3 space-y-0">
              {person.history.map((h, i) => (
                <li key={`${h.poll_date}-${i}`}>
                  {i > 0 ? (
                    <div className="flex justify-center py-1 text-slate-300">↓</div>
                  ) : null}
                  <div className="rounded-md border border-slate-200 px-3 py-2">
                    <p className="text-xs text-slate-500">{formatPollDate(h.poll_date)}</p>
                    <p className="text-sm font-medium text-slate-900">
                      {ANSWER_LABELS[h.answer]}
                    </p>
                    {h.raw_answer && h.raw_answer !== ANSWER_LABELS[h.answer] ? (
                      <p className="text-[11px] text-slate-400">{h.raw_answer}</p>
                    ) : null}
                    {h.movement ? (
                      <p
                        className="mt-1 text-xs font-medium"
                        style={{ color: MOVEMENT_COLORS[h.movement] }}
                      >
                        {MOVEMENT_LABELS[h.movement]}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {isAdmin && !person.matched && responseId ? (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Link to campaign profile
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                Search by name, phone, email, or profile ID. Do not guess if identifiers
                conflict.
              </p>
              <div className="mt-2 flex gap-2">
                <input
                  className="input"
                  value={q}
                  placeholder="Search voters"
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void search();
                  }}
                />
                <button
                  type="button"
                  className="btn-secondary shrink-0"
                  disabled={busy}
                  onClick={() => void search()}
                >
                  Search
                </button>
              </div>
              {busy ? <Spinner inline /> : null}
              <ul className="mt-2 space-y-1">
                {hits.map((v) => (
                  <li
                    key={v.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-slate-200 px-2 py-1.5 text-xs"
                  >
                    <div>
                      <p className="font-medium text-slate-800">
                        {[v.first_name, v.last_name].filter(Boolean).join(' ') || `Voter ${v.id}`}
                      </p>
                      <p className="text-slate-500">
                        {[v.phone, v.email, v.murmuration_id].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn-primary px-2 py-1 text-xs"
                      disabled={busy}
                      onClick={() => void link(v.id)}
                    >
                      Link
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right text-slate-800">{value || '—'}</dd>
    </div>
  );
}
