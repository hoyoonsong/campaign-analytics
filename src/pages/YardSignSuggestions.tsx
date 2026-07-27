import { useEffect, useMemo, useState } from 'react';
import {
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  Circle,
  useMap,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Alert, PageHeader, Spinner } from '../components/ui';
import {
  fetchFilterOptions,
  fetchYardSignSuggestions,
  type YardSignSuggestion,
  type YardSignSuggestionsResult,
} from '../lib/api';
import { votersToCsv } from '../lib/csv';
import { COUNTY_NAMES } from '../lib/idahoCounties';
import { VoterProfileModal } from '../components/VoterProfileModal';

const suggestIcon = L.divIcon({
  className: '',
  html: `<span style="display:block;width:14px;height:14px;border-radius:9999px;background:#b45309;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.35)"></span>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

function FitSuggestions({ points }: { points: Array<[number, number]> }) {
  const map = useMap();
  useEffect(() => {
    const t = window.setTimeout(() => map.invalidateSize(), 40);
    if (points.length === 0) {
      map.setView([44.0, -115.5], 6);
      return () => window.clearTimeout(t);
    }
    if (points.length === 1) {
      map.setView(points[0], 12);
    } else {
      map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 12 });
    }
    return () => window.clearTimeout(t);
  }, [map, points]);
  return null;
}

const EXPORT_COLS = [
  'rank',
  'voter_id',
  'first_name',
  'last_name',
  'email',
  'phone',
  'address_line_1',
  'city',
  'zip',
  'county',
  'party',
  'covers',
  'has_contact',
  'already_has_sign',
  'supporter_tag',
  'lat',
  'lng',
];

export default function YardSignSuggestions() {
  const [radius, setRadius] = useState(0.5);
  const [maxN, setMaxN] = useState(40);
  const [county, setCounty] = useState('');
  const [counties, setCounties] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<YardSignSuggestionsResult | null>(null);
  const [profileId, setProfileId] = useState<number | null>(null);

  useEffect(() => {
    void fetchFilterOptions()
      .then((o) => {
        const list =
          (o.counties?.length ? o.counties : null) ?? COUNTY_NAMES;
        setCounties(list);
        const ada = list.find((c) => c.toLowerCase() === 'ada');
        if (ada) setCounty(ada);
        else if (list[0]) setCounty(list[0]);
      })
      .catch(() => {
        setCounties(COUNTY_NAMES);
        const ada = COUNTY_NAMES.find((c) => c.toLowerCase() === 'ada');
        if (ada) setCounty(ada);
      });
  }, []);

  const run = async () => {
    if (!county.trim()) {
      setError('Pick a county first.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchYardSignSuggestions({
        radius_miles: radius,
        max_suggestions: maxN,
        county: [county],
      });
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to compute suggestions');
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  // Auto-run once county is known.
  useEffect(() => {
    if (!county) return;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [county]);

  const mapPoints = useMemo(
    () =>
      (result?.suggestions ?? []).map(
        (s) => [s.lat, s.lng] as [number, number],
      ),
    [result],
  );

  const exportCsv = () => {
    if (!result?.suggestions.length) return;
    const rows = result.suggestions.map((s) => ({
      rank: s.rank,
      voter_id: s.voter_id,
      first_name: s.first_name,
      last_name: s.last_name,
      email: s.email,
      phone: s.phone,
      address_line_1: s.address_line_1,
      city: s.city,
      zip: s.zip,
      county: s.county,
      party: s.party,
      covers: s.covers,
      has_contact: s.has_contact,
      already_has_sign: s.already_has_sign,
      supporter_tag: s.supporter_tag,
      lat: s.lat,
      lng: s.lng,
    }));
    const csv = votersToCsv(rows as unknown as Record<string, unknown>[], EXPORT_COLS);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `yard-sign-suggestions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader
        title="Yard sign suggestions"
        description="Pick a county, then find homes to ask for a yard sign so mapped voters are within your coverage radius. Existing FormHandler yard-sign pins count as already covered."
        actions={
          <button
            type="button"
            className="btn-secondary"
            disabled={!result?.suggestions.length}
            onClick={exportCsv}
          >
            Export CSV
          </button>
        }
      />

      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block text-sm">
          <span className="label">Coverage radius (mi)</span>
          <input
            className="input"
            type="number"
            min={0.1}
            max={5}
            step={0.1}
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value) || 0.5)}
          />
        </label>
        <label className="block text-sm">
          <span className="label">Max suggestions</span>
          <input
            className="input"
            type="number"
            min={5}
            max={100}
            step={5}
            value={maxN}
            onChange={(e) => setMaxN(Number(e.target.value) || 40)}
          />
        </label>
        <label className="block text-sm">
          <span className="label">County</span>
          <select
            className="input"
            value={county}
            onChange={(e) => setCounty(e.target.value)}
          >
            <option value="">Select county…</option>
            {counties.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <button
            type="button"
            className="btn-primary w-full"
            disabled={loading || !county}
            onClick={() => void run()}
          >
            {loading ? 'Computing…' : 'Recompute'}
          </button>
        </div>
      </div>

      {!county && !loading && (
        <p className="mb-4 text-sm text-slate-500">
          Choose a county to run suggestions (required for speed).
        </p>
      )}

      {error && (
        <div className="mb-4">
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      {loading && (
        <Spinner label={`Computing coverage for ${county || 'county'}…`} />
      )}

      {result && !loading && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Existing signs" value={result.existing_signs} />
            <Stat label={`Voters in ${result.county ?? county}`} value={result.voters_with_coords} />
            <Stat label="Already covered" value={result.already_covered} />
            <Stat label="Uncovered" value={result.uncovered} />
            <Stat label="Suggestions" value={result.suggestions.length} />
          </div>

          <div className="card mb-4 overflow-hidden">
            <div className="border-b border-slate-200 px-4 py-2 text-xs text-slate-500">
              Amber pins = suggested contacts · circle = {result.radius_miles} mi
              coverage if they put up a sign
            </div>
            <div className="h-[320px] sm:h-[400px]">
              <MapContainer
                center={[44, -115.5]}
                zoom={6}
                scrollWheelZoom
                style={{ height: '100%', width: '100%' }}
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <FitSuggestions points={mapPoints} />
                {result.suggestions.map((s) => (
                  <SuggestionMarker key={s.voter_id} s={s} radius={result.radius_miles} />
                ))}
              </MapContainer>
            </div>
          </div>

          <div className="card overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Contact</th>
                  <th className="px-3 py-2 font-medium">Covers</th>
                  <th className="px-3 py-2 font-medium">Address</th>
                  <th className="px-3 py-2 font-medium">Email / phone</th>
                  <th className="px-3 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {result.suggestions.map((s) => (
                  <tr
                    key={s.voter_id}
                    className="border-b border-slate-100 last:border-0"
                  >
                    <td className="px-3 py-2 text-slate-500">{s.rank}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="font-medium text-brand-700 hover:underline"
                        onClick={() => setProfileId(s.voter_id)}
                      >
                        {[s.first_name, s.last_name].filter(Boolean).join(' ') ||
                          'Unnamed'}
                      </button>
                    </td>
                    <td className="px-3 py-2 font-medium text-slate-800">
                      {s.covers.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {[s.address_line_1, s.city, s.zip].filter(Boolean).join(', ')}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {[s.email, s.phone].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {[
                        s.has_contact ? null : 'No contact',
                        s.already_has_sign ? 'Already has sign' : null,
                        s.supporter_tag,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {result.suggestions.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-slate-500">
                Everyone with coordinates is already within {result.radius_miles}{' '}
                mi of an existing yard sign
                {county ? ` in ${county}` : ''}.
              </p>
            )}
          </div>
        </>
      )}

      {profileId != null && (
        <VoterProfileModal
          voterId={profileId}
          onClose={() => setProfileId(null)}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="text-lg font-semibold text-slate-900">
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function SuggestionMarker({
  s,
  radius,
}: {
  s: YardSignSuggestion;
  radius: number;
}) {
  return (
    <>
      <Circle
        center={[s.lat, s.lng]}
        radius={radius * 1609.34}
        pathOptions={{
          color: '#b45309',
          weight: 1,
          fillColor: '#f59e0b',
          fillOpacity: 0.08,
        }}
      />
      <Marker position={[s.lat, s.lng]} icon={suggestIcon}>
        <Popup>
          <div className="space-y-0.5 text-sm">
            <p className="font-semibold">
              #{s.rank}{' '}
              {[s.first_name, s.last_name].filter(Boolean).join(' ')}
            </p>
            <p className="text-slate-600">Covers {s.covers} voters</p>
            <p className="text-slate-600">
              {[s.address_line_1, s.city, s.zip].filter(Boolean).join(', ')}
            </p>
          </div>
        </Popup>
      </Marker>
    </>
  );
}
