import { clearClientDataCaches } from './api';
import { supabase } from './supabase';

export type ImportBatch = {
  id: string;
  filename: string | null;
  status: string;
  total_rows: number;
  inserted_rows: number;
  updated_rows: number;
  skipped_rows: number;
  error_summary: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  undone_at?: string | null;
  undone_by?: string | null;
};

async function authHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export async function listImportBatches(): Promise<ImportBatch[]> {
  const headers = await authHeaders();
  const res = await fetch('/api/voter/import-batches', {
    method: 'GET',
    headers,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : 'Failed to load batches');
  }
  return (body.batches as ImportBatch[]) ?? [];
}

export async function finalizeImportBatch(opts: {
  batchId: string;
  status?: 'completed' | 'failed' | 'partial';
  filename?: string;
  inserted?: number;
  updated?: number;
  skipped?: number;
}): Promise<void> {
  const headers = await authHeaders();
  await fetch('/api/voter/import-batches', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts),
  });
  clearClientDataCaches();
}

export async function undoImportBatch(
  batchId: string,
): Promise<{ deleted: number }> {
  const headers = await authHeaders();
  const res = await fetch('/api/voter/undo-import', {
    method: 'POST',
    headers,
    body: JSON.stringify({ batchId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof body?.error === 'string' ? body.error : 'Undo failed',
    );
  }
  clearClientDataCaches();
  return { deleted: Number(body.deleted) || 0 };
}
