import { useEffect, useState } from 'react';
import { detectPollDateFromHeader, pollDisplayName, type TrackingPoll } from '../lib/trackingPoll';
import { Modal } from './ui';

export type PendingPollFile = {
  filename: string;
  inferredDate: string | null;
  headers: string[];
};

export type FilePollAssignment = number | 'columns';

function defaultAssignment(
  file: PendingPollFile,
  polls: TrackingPoll[],
): FilePollAssignment | '' {
  if (file.inferredDate) {
    const hit = polls.find((p) => p.poll_date === file.inferredDate);
    if (hit) return hit.id;
  }
  const hasDateColumns = file.headers.some((h) => detectPollDateFromHeader(h));
  if (hasDateColumns) return 'columns';
  if (polls.length === 1) return polls[0].id;
  return '';
}

export function TrackingPollAssignModal({
  open,
  files,
  polls,
  onClose,
  onNewPoll,
  onConfirm,
}: {
  open: boolean;
  files: PendingPollFile[];
  polls: TrackingPoll[];
  onClose: () => void;
  onNewPoll: (initialDate?: string | null) => void;
  onConfirm: (assignments: FilePollAssignment[]) => void;
}) {
  const [assign, setAssign] = useState<Array<FilePollAssignment | ''>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAssign(files.map((file) => defaultAssignment(file, polls)));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- new polls should not reset chosen rows
  }, [open, files]);

  useEffect(() => {
    if (!open) return;
    setAssign((rows) => {
      if (rows.length !== files.length) return rows;
      return rows.map((row, i) => (row === '' ? defaultAssignment(files[i], polls) || '' : row));
    });
  }, [open, files, polls]);

  const setAt = (index: number, value: FilePollAssignment | '') => {
    setAssign((rows) => rows.map((row, i) => (i === index ? value : row)));
  };

  const submit = () => {
    if (assign.some((a) => a === '')) {
      setError('Choose a poll for each file, or use date columns in the file.');
      return;
    }
    onConfirm(assign as FilePollAssignment[]);
  };

  return (
    <Modal
      open={open}
      title={files.length > 1 ? 'Assign files to polls' : 'Import into a poll'}
      description="Each CSV goes into one poll. Wide exports with Poll YYYY-MM-DD columns can still split across dates."
      onClose={onClose}
      xl={files.length > 2}
      wide={files.length <= 2}
    >
      <div className="space-y-3">
        {error ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        ) : null}
        {polls.length === 0 ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            No polls yet. Create one, or choose “Date columns in this file” if the CSV has Poll
            YYYY-MM-DD headers.
          </p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3 font-medium">File</th>
                <th className="py-2 pr-3 font-medium">Import into</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file, i) => (
                <tr key={`${file.filename}-${i}`} className="border-b border-slate-100">
                  <td className="py-2 pr-3 align-top">
                    <p className="font-medium text-slate-800">{file.filename}</p>
                    {file.inferredDate ? (
                      <p className="text-xs text-slate-500">
                        Filename looks like {file.inferredDate}
                      </p>
                    ) : null}
                  </td>
                  <td className="py-2">
                    <select
                      className="input py-1.5"
                      value={assign[i] === '' ? '' : String(assign[i])}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === '') setAt(i, '');
                        else if (v === 'columns') setAt(i, 'columns');
                        else setAt(i, Number(v));
                      }}
                    >
                      <option value="">Choose…</option>
                      {polls.map((p) => (
                        <option key={p.id} value={p.id}>
                          {pollDisplayName(p)}
                        </option>
                      ))}
                      <option value="columns">Date columns in this file</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="btn-ghost px-0 text-sm text-brand-700"
          onClick={() =>
            onNewPoll(files.find((_, i) => assign[i] === '')?.inferredDate ?? files[0]?.inferredDate)
          }
        >
          New poll
        </button>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={submit}>
            Continue to mapping
          </button>
        </div>
      </div>
    </Modal>
  );
}
