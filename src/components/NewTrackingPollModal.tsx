import { useEffect, useState } from 'react';
import { createTrackingPolls } from '../lib/api';
import type { TrackingPoll } from '../lib/trackingPoll';
import { Modal } from './ui';

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function localIsoDate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

type Draft = { date: string; label: string };

export function NewTrackingPollModal({
  open,
  initialDate,
  onClose,
  onCreated,
}: {
  open: boolean;
  initialDate?: string | null;
  onClose: () => void;
  onCreated: (polls: TrackingPoll[]) => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([{ date: '', label: '' }]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDrafts([{ date: initialDate || localIsoDate(), label: '' }]);
    setError(null);
    setSaving(false);
  }, [open, initialDate]);

  const update = (index: number, patch: Partial<Draft>) => {
    setDrafts((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const submit = async () => {
    const polls = drafts
      .map((d) => ({
        poll_date: d.date.trim(),
        label: d.label.trim() || null,
      }))
      .filter((d) => d.poll_date);
    if (polls.length === 0) {
      setError('Add a poll date.');
      return;
    }
    if (polls.some((p) => !/^\d{4}-\d{2}-\d{2}$/.test(p.poll_date))) {
      setError('Each poll needs a valid date.');
      return;
    }
    const dates = polls.map((p) => p.poll_date);
    if (new Set(dates).size !== dates.length) {
      setError('Each poll needs its own date.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await createTrackingPolls(polls);
      onCreated(res.polls);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create poll');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={drafts.length > 1 ? 'New tracking polls' : 'New tracking poll'}
      description="Create empty polls first, then import a CSV into each one. Date is unique — two waves on the same day share one poll."
      onClose={onClose}
      wide={drafts.length > 1}
      elevated
    >
      <div className="space-y-3">
        {error ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        ) : null}
        {drafts.map((draft, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[160px_1fr_auto] sm:items-end">
            <label className="block">
              <span className="label">Date</span>
              <input
                type="date"
                className="input"
                value={draft.date}
                onChange={(e) => update(i, { date: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="label">Label (optional)</span>
              <input
                type="text"
                className="input"
                placeholder="April wave"
                value={draft.label}
                onChange={(e) => update(i, { label: e.target.value })}
              />
            </label>
            {drafts.length > 1 ? (
              <button
                type="button"
                className="btn-ghost mb-0.5"
                onClick={() => setDrafts((rows) => rows.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
        <button
          type="button"
          className="btn-ghost px-0 text-sm text-brand-700"
          onClick={() => setDrafts((rows) => [...rows, { date: '', label: '' }])}
        >
          Add another poll
        </button>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => void submit()} disabled={saving}>
            {saving
              ? 'Creating…'
              : drafts.length > 1
                ? `Create ${drafts.length} polls`
                : 'Create poll'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
