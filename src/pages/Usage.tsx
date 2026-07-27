import { useEffect, useState } from 'react';
import { Alert, PageHeader, Spinner } from '../components/ui';
import { fetchUsage } from '../lib/api';
import type { DbUsage } from '../lib/types';

export default function Usage() {
  const [usage, setUsage] = useState<DbUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void fetchUsage()
      .then(setUsage)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <PageHeader
        title="Voter database usage"
        description="Informational storage stats from the voter Supabase project. No artificial voter-count limits."
      />

      {error && <Alert variant="error">{error}</Alert>}
      {loading && <Spinner label="Loading usage…" />}

      {usage && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Stat label="Voters" value={usage.voter_count.toLocaleString()} />
          <Stat label="Table size" value={usage.table_size} />
          <Stat label="Index size" value={usage.index_size} />
          <Stat label="Total relation size" value={usage.total_relation_size} />
          <Stat label="Database size" value={usage.database_size} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-xl font-bold text-slate-900">{value}</p>
    </div>
  );
}
