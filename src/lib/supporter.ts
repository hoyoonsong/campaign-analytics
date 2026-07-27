/** Supporter column: tag first; nearby distances are a separate column. */
export function supporterLabel(row: {
  supporter_tag?: string | null;
  is_campaign_volunteer?: boolean | null;
  nearby_yard_sign_miles?: number | null;
  nearby_volunteer_miles?: number | null;
}): string {
  const tag = row.supporter_tag?.trim();
  if (tag) return tag;
  if (row.is_campaign_volunteer) return 'volunteer';
  return '—';
}

export function nearbyLabel(row: {
  supporter_tag?: string | null;
  nearby_yard_sign_miles?: number | null;
  nearby_volunteer_miles?: number | null;
}): string {
  const parts: string[] = [];
  if (
    row.nearby_yard_sign_miles != null &&
    Number.isFinite(Number(row.nearby_yard_sign_miles))
  ) {
    parts.push(`Yard ${Number(row.nearby_yard_sign_miles).toFixed(1)} mi`);
  }
  if (
    row.nearby_volunteer_miles != null &&
    Number.isFinite(Number(row.nearby_volunteer_miles))
  ) {
    parts.push(`Vol ${Number(row.nearby_volunteer_miles).toFixed(1)} mi`);
  }
  return parts.length ? parts.join(' · ') : '—';
}
