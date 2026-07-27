import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const v = createClient(
  process.env.VOTER_SUPABASE_URL!,
  process.env.VOTER_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const PATCHES: Record<string, { tag: string; priority: number }> = {
  'achilles vote': { tag: 'supporter', priority: 30 },
  'oppose achilles': { tag: 'opposed', priority: 20 },
  maybe: { tag: 'maybe', priority: 10 },
};

async function main() {
  const { data, error } = await v
    .from('saved_voter_universes')
    .select('id,name,filters,supporter_tag,tag_priority');
  if (error) throw error;

  for (const u of data ?? []) {
    const fb = PATCHES[(u.name ?? '').trim().toLowerCase()];
    if (!fb) continue;
    const filters = {
      ...((u.filters ?? {}) as Record<string, unknown>),
      _supporter_tag: fb.tag,
      _tag_priority: fb.priority,
    };
    const { error: upErr } = await v
      .from('saved_voter_universes')
      .update({
        supporter_tag: fb.tag,
        tag_priority: fb.priority,
        filters,
      })
      .eq('id', u.id);
    if (upErr) throw upErr;
    console.log('patched', u.name, '→', fb.tag);
  }

  console.log('Universe tags patched. Search enrichment tags each page live.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
