import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { SupabaseClient } from '@supabase/supabase-js';
import { json, readBody, requireCampaignUser } from '../../_lib/auth.js';

function isAdmin(role: string) {
  return role === 'admin';
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64);
}

function unwrapPetition(data: unknown): Record<string, unknown> | null {
  if (data == null) return null;
  if (typeof data === 'string') {
    try {
      return unwrapPetition(JSON.parse(data));
    } catch {
      return null;
    }
  }
  if (typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return null;
}

const PETITION_COLS =
  'id, slug, label, short_label, bit_index, sort_order, is_default, is_active, group_id, created_at, created_by';

const GROUP_COLS = 'id, slug, label, short_label, sort_order, created_at';

async function insertPetition(
  voter: SupabaseClient,
  args: {
    label: string;
    slug?: string | null;
    short_label?: string | null;
    is_default?: boolean;
    actor?: string;
  },
) {
  const slug = slugify(args.slug?.trim() || args.label);
  if (!slug) return { error: 'label is required', petition: null };

  const { data: existing, error: existingErr } = await voter
    .from('petitions')
    .select(PETITION_COLS)
    .eq('slug', slug)
    .maybeSingle();
  if (existingErr) return { error: existingErr.message, petition: null };
  if (existing) return { error: null, petition: existing };

  const { data: rows, error: listErr } = await voter
    .from('petitions')
    .select('bit_index, sort_order');
  if (listErr) return { error: listErr.message, petition: null };
  const list = (rows as Array<{ bit_index: number; sort_order: number }> | null) ?? [];
  const used = new Set(list.map((r) => r.bit_index));
  let bit = 0;
  while (used.has(bit) && bit <= 62) bit += 1;
  if (bit > 62) return { error: 'No free petition bit_index (max 63)', petition: null };
  const maxSort = Math.max(0, ...list.map((r) => r.sort_order ?? 0));
  const short = (args.short_label?.trim() || args.label).slice(0, 16) || slug;

  const { data, error } = await voter
    .from('petitions')
    .insert({
      slug,
      label: args.label,
      short_label: short,
      bit_index: bit,
      sort_order: maxSort + 10,
      is_default: Boolean(args.is_default),
      is_active: true,
      created_by: args.actor ?? null,
    })
    .select(PETITION_COLS)
    .single();
  if (error) return { error: error.message, petition: null };
  return { error: null, petition: data };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireCampaignUser(req, res);
  if (!ctx) return;

  if (req.method === 'GET') {
    const [petRes, groupRes] = await Promise.all([
      ctx.voter
        .from('petitions')
        .select(PETITION_COLS)
        .order('sort_order', { ascending: true })
        .order('slug', { ascending: true }),
      ctx.voter
        .from('petition_groups')
        .select(GROUP_COLS)
        .order('sort_order', { ascending: true })
        .order('slug', { ascending: true }),
    ]);
    if (petRes.error) {
      const missingCol = /group_id|does not exist|schema cache/i.test(
        petRes.error.message,
      );
      if (!missingCol) return json(res, 500, { error: petRes.error.message });
      const fallback = await ctx.voter
        .from('petitions')
        .select(
          'id, slug, label, short_label, bit_index, sort_order, is_default, is_active, created_at, created_by',
        )
        .order('sort_order', { ascending: true })
        .order('slug', { ascending: true });
      if (fallback.error) return json(res, 500, { error: fallback.error.message });
      return json(res, 200, { petitions: fallback.data ?? [], groups: [] });
    }
    const groups = groupRes.error ? [] : (groupRes.data ?? []);
    return json(res, 200, { petitions: petRes.data ?? [], groups });
  }

  if (req.method === 'POST') {
    if (!isAdmin(ctx.profile.role)) {
      return json(res, 403, { error: 'Admin only' });
    }
    const body = readBody<{
      label?: string;
      slug?: string;
      short_label?: string;
      is_default?: boolean;
      kind?: string;
      petition_ids?: number[];
    }>(req);
    const label = String(body.label ?? '').trim();
    if (!label) return json(res, 400, { error: 'label is required' });

    if (body.kind === 'group') {
      return createGroup(ctx.voter, res, {
        label,
        short_label: body.short_label?.trim() || null,
        petition_ids: body.petition_ids ?? [],
      });
    }

    const { data, error } = await ctx.voter.rpc('create_petition', {
      p_label: label,
      p_slug: body.slug?.trim() || null,
      p_short_label: body.short_label?.trim() || null,
      p_is_default: Boolean(body.is_default),
      p_actor: ctx.user.id,
    });

    const rpcMissing =
      !!error &&
      /does not exist|schema cache|could not find the function/i.test(error.message);

    if (error && !rpcMissing) {
      return json(res, 500, { error: error.message });
    }

    if (!error) {
      const rec = unwrapPetition(data);
      if (rec && typeof rec.error === 'string') {
        return json(res, 400, { error: rec.error });
      }
      if (rec && rec.slug) {
        return json(res, 200, { petition: rec });
      }
    }

    const fallback = await insertPetition(ctx.voter, {
      label,
      slug: body.slug?.trim() || null,
      short_label: body.short_label?.trim() || null,
      is_default: Boolean(body.is_default),
      actor: ctx.user.id,
    });
    if (fallback.error || !fallback.petition) {
      return json(res, 500, { error: fallback.error ?? 'Failed to create petition' });
    }
    return json(res, 200, { petition: fallback.petition });
  }

  if (req.method === 'PATCH') {
    if (!isAdmin(ctx.profile.role)) {
      return json(res, 403, { error: 'Admin only' });
    }
    const body = readBody<{
      id?: number;
      kind?: string;
      label?: string;
      short_label?: string;
      sort_order?: number;
      is_default?: boolean;
      is_active?: boolean;
      group_id?: number | null;
    }>(req);
    const id = Number(body.id);
    if (!Number.isFinite(id) || id <= 0) {
      return json(res, 400, { error: 'id is required' });
    }

    if (body.kind === 'group') {
      const patch: Record<string, unknown> = {};
      if (typeof body.label === 'string' && body.label.trim()) {
        patch.label = body.label.trim();
      }
      if (typeof body.short_label === 'string' && body.short_label.trim()) {
        patch.short_label = body.short_label.trim();
      }
      if (typeof body.sort_order === 'number') patch.sort_order = body.sort_order;
      if (Object.keys(patch).length === 0) {
        return json(res, 400, { error: 'No fields to update' });
      }
      const { data, error } = await ctx.voter
        .from('petition_groups')
        .update(patch)
        .eq('id', id)
        .select(GROUP_COLS)
        .single();
      if (error) return json(res, 500, { error: error.message });
      return json(res, 200, { group: data });
    }

    const patch: Record<string, unknown> = {};
    if (typeof body.label === 'string' && body.label.trim()) {
      patch.label = body.label.trim();
    }
    if (typeof body.short_label === 'string' && body.short_label.trim()) {
      patch.short_label = body.short_label.trim();
    }
    if (typeof body.sort_order === 'number') patch.sort_order = body.sort_order;
    if (typeof body.is_default === 'boolean') patch.is_default = body.is_default;
    if (typeof body.is_active === 'boolean') patch.is_active = body.is_active;
    if (body.group_id === null) patch.group_id = null;
    else if (typeof body.group_id === 'number' && body.group_id > 0) {
      patch.group_id = body.group_id;
    }
    if (Object.keys(patch).length === 0) {
      return json(res, 400, { error: 'No fields to update' });
    }
    const { data, error } = await ctx.voter
      .from('petitions')
      .update(patch)
      .eq('id', id)
      .select(PETITION_COLS)
      .single();
    if (error) return json(res, 500, { error: error.message });
    if (Object.prototype.hasOwnProperty.call(patch, 'group_id')) {
      await deleteEmptyGroups(ctx.voter);
    }
    return json(res, 200, { petition: data });
  }

  if (req.method === 'DELETE') {
    if (!isAdmin(ctx.profile.role)) {
      return json(res, 403, { error: 'Admin only' });
    }
    const body = readBody<{ id?: number; kind?: string }>(req);
    const id = Number(body.id);
    if (!Number.isFinite(id) || id <= 0) {
      return json(res, 400, { error: 'id is required' });
    }

    if (body.kind === 'group') {
      await ctx.voter.from('petitions').update({ group_id: null }).eq('group_id', id);
      const { error } = await ctx.voter.from('petition_groups').delete().eq('id', id);
      if (error) return json(res, 500, { error: error.message });
      return json(res, 200, { ok: true });
    }

    const { data, error } = await ctx.voter.rpc('delete_petition', { p_id: id });
    if (error) return json(res, 500, { error: error.message });
    const rec = unwrapPetition(data);
    if (rec && typeof rec.error === 'string') {
      return json(res, 400, { error: rec.error });
    }
    await deleteEmptyGroups(ctx.voter);
    return json(res, 200, { ok: true, petition: rec });
  }

  return json(res, 405, { error: 'Method not allowed' });
}

async function createGroup(
  voter: SupabaseClient,
  res: VercelResponse,
  args: { label: string; short_label: string | null; petition_ids: number[] },
) {
  const ids = [...new Set(args.petition_ids.map((n) => Number(n)).filter((n) => n > 0))];
  if (ids.length < 2) {
    return json(res, 400, { error: 'Select at least two petitions to group' });
  }
  let slug = slugify(args.label);
  if (!slug) return json(res, 400, { error: 'label is required' });

  const { data: existing } = await voter
    .from('petition_groups')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  if (existing) slug = `${slug}_${Date.now().toString(36)}`.slice(0, 64);

  const { data: sortRows } = await voter.from('petition_groups').select('sort_order');
  const maxSort = Math.max(
    0,
    ...((sortRows as Array<{ sort_order: number }> | null) ?? []).map(
      (r) => r.sort_order ?? 0,
    ),
  );
  const short = (args.short_label || args.label).slice(0, 16);

  const { data: group, error } = await voter
    .from('petition_groups')
    .insert({
      slug,
      label: args.label,
      short_label: short,
      sort_order: maxSort + 10,
    })
    .select(GROUP_COLS)
    .single();
  if (error || !group) {
    return json(res, 500, { error: error?.message ?? 'Failed to create group' });
  }

  const { error: assignErr } = await voter
    .from('petitions')
    .update({ group_id: (group as { id: number }).id })
    .in('id', ids);
  if (assignErr) return json(res, 500, { error: assignErr.message });
  await deleteEmptyGroups(voter);
  return json(res, 200, { group });
}

async function deleteEmptyGroups(voter: SupabaseClient) {
  const { data: groups } = await voter.from('petition_groups').select('id');
  const { data: used } = await voter
    .from('petitions')
    .select('group_id')
    .not('group_id', 'is', null);
  const live = new Set(
    ((used as Array<{ group_id: number }> | null) ?? []).map((r) => r.group_id),
  );
  const empty = ((groups as Array<{ id: number }> | null) ?? [])
    .map((g) => g.id)
    .filter((id) => !live.has(id));
  if (empty.length) {
    await voter.from('petition_groups').delete().in('id', empty);
  }
}
