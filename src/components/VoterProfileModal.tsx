import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  fetchVoterProfile,
  type CampaignPersonDetail,
  type NearbyKind,
} from '../lib/api';
import { NearbyPinModal } from './NearbyPinModal';
import { Spinner } from './ui';

export type VoterProfile = Record<string, unknown> & {
  id: number;
  murmuration_id?: string | null;
  voter_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  age?: number | null;
  address_line_1?: string | null;
  city?: string | null;
  county?: string | null;
  zip?: string | null;
  state?: string | null;
  lat?: number | null;
  lng?: number | null;
  party?: string | null;
  status?: string | null;
  voter_registered?: string | null;
  support_score?: number | null;
  volunteer_interest?: string | null;
  yard_sign?: string | null;
  newsletter?: string | null;
  legacy_volunteer?: string | null;
  donated?: string | null;
  attended_event?: string | null;
  supporter_tag?: string | null;
  is_campaign_volunteer?: boolean | null;
  campaign_person_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  petition_signatures?: Array<{
    slug: string;
    label: string;
    raw_value?: string | null;
  }>;
};

function present(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s !== '' && s !== 'false' && s !== 'no' && s !== '0' && s !== 'n';
  }
  if (typeof v === 'number') return v !== 0;
  return Boolean(v);
}

function labelVal(v: unknown): string {
  if (v == null || v === '') return '—';
  return String(v);
}

function fmtMiles(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return `${n.toFixed(1)} mi`;
}

export function VoterProfileModal({
  voterId,
  onClose,
}: {
  voterId: number;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [voter, setVoter] = useState<VoterProfile | null>(null);
  const [campaign, setCampaign] = useState<CampaignPersonDetail | null>(null);
  const [nearby, setNearby] = useState<{
    yard_sign_miles: number | null;
    volunteer_miles: number | null;
  } | null>(null);
  const [nearbyKind, setNearbyKind] = useState<NearbyKind | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void fetchVoterProfile(voterId)
      .then((r) => {
        if (!active) return;
        setVoter(r.voter as VoterProfile);
        setCampaign(r.campaign);
        setNearby(r.nearby);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [voterId]);

  const name = [voter?.first_name, voter?.last_name].filter(Boolean).join(' ') || 'Voter';

  const chips = useMemo(() => {
    if (!voter) {
      return [] as {
        label: string;
        tone: string;
        nearbyKind?: NearbyKind;
      }[];
    }
    const out: {
      label: string;
      tone: string;
      nearbyKind?: NearbyKind;
    }[] = [];
    if (voter.supporter_tag) {
      out.push({
        label: String(voter.supporter_tag),
        tone: 'bg-indigo-100 text-indigo-800',
      });
    }
    if (voter.is_campaign_volunteer || campaign?.volunteer) {
      out.push({ label: 'Campaign volunteer', tone: 'bg-sky-100 text-sky-800' });
    } else if (present(voter.volunteer_interest) || present(voter.legacy_volunteer)) {
      out.push({ label: 'Volunteer interest', tone: 'bg-sky-100 text-sky-800' });
    }
    if (present(voter.yard_sign) || (campaign?.yard_signs?.length ?? 0) > 0) {
      out.push({ label: 'Yard sign', tone: 'bg-amber-100 text-amber-800' });
    }
    if (present(voter.newsletter)) {
      out.push({ label: 'Newsletter', tone: 'bg-violet-100 text-violet-800' });
    }
    if (present(voter.donated)) {
      out.push({ label: 'Donor', tone: 'bg-emerald-100 text-emerald-800' });
    }
    if (present(voter.attended_event) || (campaign?.event_attendances?.length ?? 0) > 0) {
      out.push({ label: 'Event attendee', tone: 'bg-brand-100 text-brand-800' });
    }
    if (voter.support_score != null) {
      out.push({
        label: `Support ${voter.support_score}/5`,
        tone: 'bg-slate-100 text-slate-700',
      });
    }
    const ys = fmtMiles(nearby?.yard_sign_miles);
    const vs = fmtMiles(nearby?.volunteer_miles);
    if (ys) {
      out.push({
        label: `Yard sign ${ys}`,
        tone: 'bg-amber-50 text-amber-900',
        nearbyKind: 'yard_sign',
      });
    }
    if (vs) {
      out.push({
        label: `Volunteer ${vs}`,
        tone: 'bg-sky-50 text-sky-900',
        nearbyKind: 'volunteer',
      });
    }
    return out;
  }, [voter, campaign, nearby]);

  const history = useMemo(() => {
    if (!voter) return [] as { title: string; detail: string }[];
    const items: { title: string; detail: string }[] = [];

    if (voter.petition_signatures?.length) {
      for (const sig of voter.petition_signatures) {
        items.push({
          title: sig.label,
          detail: sig.raw_value ? String(sig.raw_value) : 'Signed',
        });
      }
    } else {
      const sigs: [string, unknown][] = [
        ['Open Primaries petition', voter.sig_open_primaries],
        ['Reproductive Freedom signature', voter.sig_reproductive_freedom],
        ['Achilles petition', voter.sig_achilles_petition],
        ['Medical Cannabis Act', voter.sig_medical_cannabis],
        ['Medical Marijuana valid code', voter.sig_medical_marijuana_valid_code],
        ['Reproductive Freedom valid code', voter.sig_reproductive_freedom_valid_code],
      ];
      for (const [title, val] of sigs) {
        if (present(val)) items.push({ title, detail: String(val) });
      }
    }

    if (present(voter.volunteer_interest)) {
      items.push({ title: 'Volunteer interest', detail: String(voter.volunteer_interest) });
    }
    if (present(voter.yard_sign)) {
      items.push({ title: 'Yard sign (voter file)', detail: String(voter.yard_sign) });
    }
    if (present(voter.newsletter)) {
      items.push({ title: 'Newsletter', detail: String(voter.newsletter) });
    }
    if (present(voter.legacy_volunteer)) {
      items.push({ title: 'Legacy volunteer', detail: String(voter.legacy_volunteer) });
    }
    if (present(voter.donated)) {
      items.push({ title: 'Donated', detail: String(voter.donated) });
    }
    if (present(voter.attended_event)) {
      items.push({ title: 'Attended event (voter file)', detail: String(voter.attended_event) });
    }

    if (present(voter.alignment_label) || present(voter.alignment_score)) {
      items.push({
        title: 'Alignment',
        detail: [voter.alignment_label, voter.alignment_score].filter(Boolean).join(' · '),
      });
    }
    if (present(voter.top_main_topic)) {
      items.push({ title: 'Top topic', detail: String(voter.top_main_topic) });
    }
    if (present(voter.contact_tags)) {
      items.push({ title: 'Contact tags', detail: String(voter.contact_tags) });
    }
    if (present(voter.convos_candidate_support)) {
      items.push({
        title: 'Candidate support',
        detail: String(voter.convos_candidate_support),
      });
    }
    if (present(voter.convos_contact_status)) {
      items.push({
        title: 'Contact status',
        detail: String(voter.convos_contact_status),
      });
    }
    if (present(voter.convos_poll_question)) {
      items.push({
        title: 'Poll question',
        detail: String(voter.convos_poll_question),
      });
    }

    return items;
  }, [voter]);

  const vol = campaign?.volunteer;

  const body = (
    <div className="fixed inset-0 z-[5000] flex items-start justify-center overflow-y-auto bg-slate-900/40 p-3 sm:p-8">
      <div className="card my-4 w-full max-w-lg overflow-hidden">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-slate-900">{name}</h2>
            <p className="text-xs text-slate-500">
              {[
                voter?.murmuration_id ? `Murmuration ${voter.murmuration_id}` : null,
                voter?.voter_id ? `State voter ${voter.voter_id}` : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'No external IDs'}
            </p>
          </div>
          <button type="button" className="btn-ghost px-2 py-1 text-sm" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="max-h-[75vh] space-y-4 overflow-y-auto px-4 py-4">
          {loading && <Spinner label="Loading profile…" />}
          {error && <p className="text-sm text-red-600">{error}</p>}

          {voter && !loading && (
            <>
              {chips.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {chips.map((c) =>
                    c.nearbyKind ? (
                      <button
                        key={c.label}
                        type="button"
                        className={`badge ${c.tone} cursor-pointer underline-offset-2 hover:underline`}
                        onClick={() => setNearbyKind(c.nearbyKind!)}
                      >
                        {c.label}
                      </button>
                    ) : (
                      <span key={c.label} className={`badge ${c.tone}`}>
                        {c.label}
                      </span>
                    ),
                  )}
                </div>
              )}

              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Contact
                </h3>
                <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1.5 text-sm">
                  <dt className="text-slate-500">Email</dt>
                  <dd className="text-slate-800">{labelVal(voter.email)}</dd>
                  <dt className="text-slate-500">Phone</dt>
                  <dd className="text-slate-800">{labelVal(voter.phone)}</dd>
                  <dt className="text-slate-500">Address</dt>
                  <dd className="text-slate-800">
                    {[voter.address_line_1, voter.city, voter.state, voter.zip]
                      .filter(Boolean)
                      .join(', ') || '—'}
                  </dd>
                  <dt className="text-slate-500">County</dt>
                  <dd className="text-slate-800">{labelVal(voter.county)}</dd>
                  <dt className="text-slate-500">Age</dt>
                  <dd className="text-slate-800">{labelVal(voter.age)}</dd>
                </dl>
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Registration
                </h3>
                <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1.5 text-sm">
                  <dt className="text-slate-500">Party</dt>
                  <dd className="text-slate-800">{labelVal(voter.party)}</dd>
                  <dt className="text-slate-500">Status</dt>
                  <dd className="text-slate-800">{labelVal(voter.status)}</dd>
                  <dt className="text-slate-500">Registered</dt>
                  <dd className="text-slate-800">{labelVal(voter.voter_registered)}</dd>
                </dl>
              </section>

              {(vol || (campaign?.yard_signs?.length ?? 0) > 0 || (campaign?.event_attendances?.length ?? 0) > 0) && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Campaign ops (live)
                  </h3>
                  {vol && (
                    <div className="mb-3 rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
                      <p className="text-sm font-medium text-slate-800">Volunteer</p>
                      <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                        <li>
                          Orientation:{' '}
                          {vol.orientation_done ? 'done' : 'pending'}
                          {vol.orientation_date
                            ? ` (${String(vol.orientation_date).slice(0, 10)})`
                            : ''}
                        </li>
                        <li>
                          Phone bank:{' '}
                          {vol.phone_bank_orientation_done ? 'trained' : 'not yet'}
                        </li>
                        <li>
                          Doorknock:{' '}
                          {vol.doorknock_orientation_done ? 'trained' : 'not yet'}
                        </li>
                        {vol.county_captain ? (
                          <li>
                            County captain
                            {Array.isArray(vol.captain_counties) && vol.captain_counties.length
                              ? `: ${(vol.captain_counties as string[]).join(', ')}`
                              : ''}
                          </li>
                        ) : null}
                        {Array.isArray(vol.interests) && vol.interests.length > 0 ? (
                          <li>Interests: {(vol.interests as string[]).join(', ')}</li>
                        ) : null}
                        {Array.isArray(vol.tags) && vol.tags.length > 0 ? (
                          <li>Tags: {(vol.tags as string[]).join(', ')}</li>
                        ) : null}
                      </ul>
                    </div>
                  )}

                  {(campaign?.yard_signs?.length ?? 0) > 0 && (
                    <div className="mb-3 space-y-2">
                      <p className="text-sm font-medium text-slate-800">Yard signs</p>
                      {campaign!.yard_signs.map((y) => (
                        <div
                          key={String(y.id)}
                          className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600"
                        >
                          <p className="font-medium text-slate-800">
                            {String(y.status ?? '—')}
                            {y.is_big ? ' · big' : ''}
                            {y.quantity != null ? ` · qty ${String(y.quantity)}` : ''}
                          </p>
                          <p>{labelVal(y.address)}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {(campaign?.event_attendances?.length ?? 0) > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-slate-800">Events</p>
                      {campaign!.event_attendances.map((a) => (
                        <div
                          key={a.id}
                          className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600"
                        >
                          <p className="font-medium text-slate-800">
                            {a.event_title ?? 'Event'}
                            {a.attended ? ' · attended' : ' · RSVP'}
                          </p>
                          <p>
                            {[
                              a.event_starts_at
                                ? new Date(a.event_starts_at).toLocaleString()
                                : null,
                              a.event_location,
                              a.guests > 0 ? `${a.guests} guests` : null,
                            ]
                              .filter(Boolean)
                              .join(' · ') || '—'}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}

              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Interaction history
                </h3>
                {history.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No campaign interactions recorded yet.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {history.map((h) => (
                      <li
                        key={h.title + h.detail}
                        className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2"
                      >
                        <p className="text-sm font-medium text-slate-800">{h.title}</p>
                        <p className="text-xs text-slate-600">{h.detail}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <p className="text-xs text-slate-400">
                Updated{' '}
                {voter.updated_at
                  ? new Date(voter.updated_at).toLocaleString()
                  : '—'}
                {voter.created_at
                  ? ` · Added ${new Date(voter.created_at).toLocaleDateString()}`
                  : ''}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {createPortal(body, document.body)}
      {nearbyKind != null && (
        <NearbyPinModal
          voterId={voterId}
          kind={nearbyKind}
          onClose={() => setNearbyKind(null)}
        />
      )}
    </>
  );
}
