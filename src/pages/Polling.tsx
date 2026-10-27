import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Circle, MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { Feature, FeatureCollection } from 'geojson';
import 'leaflet/dist/leaflet.css';
import { VoterClusterLayer } from '../components/VoterClusterLayer';
import { VoterProfileModal } from '../components/VoterProfileModal';
import { Alert, EmptyState, PageHeader, Spinner } from '../components/ui';
import {
  fetchMapCampaignGeo,
  fetchPollingCounties,
  fetchPollingLocations,
  fetchPollingYardGaps,
  type PollingCountyRank,
  type PollingYardGap,
} from '../lib/api';
import { IDAHO_COUNTIES } from '../lib/idahoCounties';
import { loadCountyMapCoords, type CountyCoordPayload } from '../lib/mapCoordsCache';
import { countyKey, pollingKindLabel, type PollMapLocation } from '../lib/pollingLocations';
import { collapsePresencePins, type PresencePin, type RawPresencePin } from '../lib/presencePins';

type KindFilter = 'all' | 'election_day' | 'early_voting';

const KIND_FILTERS: { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'election_day', label: 'Election day' },
  { id: 'early_voting', label: 'Early voting' },
];

function milesText(miles: number): string {
  if (miles < 0.1) return '< 0.1 mi';
  return `${miles.toFixed(1)} mi`;
}

function placeLine(site: PollingYardGap): string {
  return [site.address_line_1, [site.city, site.zip].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
}

function siteKey(site: PollingYardGap): string {
  return `${site.kind}-${site.id}`;
}

const electionIcon = L.divIcon({
  className: '',
  html: `<svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))"><path d="M14 34.5C14 34.5 2.5 20.5 2.5 13.2a11.5 11.5 0 1 1 23 0C25.5 20.5 14 34.5 14 34.5z" fill="#1d4ed8" stroke="#fff" stroke-width="2"/><text x="14" y="16.5" text-anchor="middle" font-size="7" font-weight="800" fill="#fff" font-family="ui-sans-serif,system-ui,sans-serif">POLL</text></svg>`,
  iconSize: [28, 36],
  iconAnchor: [14, 34],
  popupAnchor: [0, -32],
});

const earlyIcon = L.divIcon({
  className: '',
  html: `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))"><path d="M16 2.5 29.5 16 16 29.5 2.5 16Z" fill="#d97706" stroke="#fff" stroke-width="2"/><text x="16" y="18.5" text-anchor="middle" font-size="6.5" font-weight="800" fill="#fff" font-family="ui-sans-serif,system-ui,sans-serif">EARLY</text></svg>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -16],
});

const yardIcon = L.divIcon({
  className: '',
  html: `<span style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:4px;background:#d97706;border:2.5px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.45);font-size:11px;font-weight:800;color:#fff;line-height:1">YS</span>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
  popupAnchor: [0, -12],
});

const bigYardIcon = L.divIcon({
  className: '',
  html: `<span style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:6px;background:#9a3412;border:2.5px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.5);font-size:9px;font-weight:800;color:#fff;line-height:1;letter-spacing:-0.02em">BIG</span>`,
  iconSize: [30, 30],
  iconAnchor: [15, 15],
  popupAnchor: [0, -16],
});

const volIcon = L.divIcon({
  className: '',
  html: `<span style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:9999px;background:#0d9488;border:2.5px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.45);font-size:10px;font-weight:800;color:#fff;line-height:1">V</span>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
  popupAnchor: [0, -12],
});

const bothIcon = L.divIcon({
  className: '',
  html: `<span style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#0d9488 50%,#d97706 50%);border:2.5px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.45);font-size:8px;font-weight:800;color:#fff;line-height:1;letter-spacing:-0.02em">V+YS</span>`,
  iconSize: [26, 26],
  iconAnchor: [13, 13],
  popupAnchor: [0, -14],
});

const bothBigIcon = L.divIcon({
  className: '',
  html: `<span style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#0d9488 50%,#9a3412 50%);border:2.5px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.5);font-size:7px;font-weight:800;color:#fff;line-height:1">V+BIG</span>`,
  iconSize: [30, 30],
  iconAnchor: [15, 15],
  popupAnchor: [0, -16],
});

function presenceIcon(pin: PresencePin) {
  if (pin.kind === 'both') return pin.is_big ? bothBigIcon : bothIcon;
  if (pin.kind === 'yard_sign') return pin.is_big ? bigYardIcon : yardIcon;
  return volIcon;
}

function countyBoundsOf(name: string | null): L.LatLngBounds | null {
  if (!name) return null;
  const fc = IDAHO_COUNTIES as unknown as FeatureCollection;
  const feature = fc.features?.find(
    (item) => (item.properties as { name?: string } | null)?.name === name,
  );
  if (!feature) return null;
  return L.geoJSON(feature as Feature).getBounds();
}

function inCounty(lat: number, lng: number, bounds: L.LatLngBounds): boolean {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  return lat >= sw.lat - 0.02 && lat <= ne.lat + 0.02 && lng >= sw.lng - 0.02 && lng <= ne.lng + 0.02;
}

function LayerToggle({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-1.5 py-0.5 ${
        on ? 'bg-slate-100 text-slate-800' : 'text-slate-400 line-through'
      }`}
    >
      {children}
    </button>
  );
}

function FitSelection({ points }: { points: [number, number][] }) {
  const map = useMap();
  const key = points.map((point) => point.join(',')).join('|');
  useEffect(() => {
    if (points.length === 0) return;
    map.invalidateSize();
    if (points.length === 1) {
      map.setView(points[0], 13);
      return;
    }
    map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 14 });
    // key already encodes the coordinates, so a new array with the same points does not refit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);
  return null;
}

export default function PollingPage() {
  const [counties, setCounties] = useState<PollingCountyRank[]>([]);
  const [countiesLoading, setCountiesLoading] = useState(true);
  const [countiesError, setCountiesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>('all');
  const [gaps, setGaps] = useState<{
    yard_sign_count: number;
    big_yard_sign_count: number;
    sites: PollingYardGap[];
  } | null>(null);
  const [gapsLoading, setGapsLoading] = useState(false);
  const [gapsError, setGapsError] = useState<string | null>(null);
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [campaignGeo, setCampaignGeo] = useState<RawPresencePin[]>([]);
  const [pollLocations, setPollLocations] = useState<PollMapLocation[]>([]);
  const [coords, setCoords] = useState<CountyCoordPayload | null>(null);
  const [pinsLoading, setPinsLoading] = useState(false);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [layers, setLayers] = useState({
    voters: true,
    yardSigns: true,
    volunteers: true,
    polls: true,
  });
  const mapAnchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setCountiesLoading(true);
    setCountiesError(null);
    void fetchPollingCounties()
      .then((data) => {
        if (!active) return;
        setCounties(data.counties);
        setSelected((current) => current ?? data.counties[0]?.name ?? null);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setCountiesError(err instanceof Error ? err.message : 'Could not load counties');
      })
      .finally(() => {
        if (active) setCountiesLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    setGaps(null);
    setPickedKey(null);
    setGapsLoading(true);
    setGapsError(null);
    void fetchPollingYardGaps(selected)
      .then((data) => {
        if (!active) return;
        setGaps({
          yard_sign_count: data.yard_sign_count,
          big_yard_sign_count: data.big_yard_sign_count,
          sites: data.sites,
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setGaps(null);
        setGapsError(err instanceof Error ? err.message : 'Could not rank polling locations');
      })
      .finally(() => {
        if (active) setGapsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected]);

  useEffect(() => {
    let active = true;
    void fetchMapCampaignGeo()
      .then((geo) => {
        if (active) setCampaignGeo(geo.campaign_geo ?? []);
      })
      .catch(() => {
        if (active) setCampaignGeo([]);
      });
    void fetchPollingLocations()
      .then((res) => {
        if (active) setPollLocations(res.locations);
      })
      .catch(() => {
        if (active) setPollLocations([]);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selected) {
      setCoords(null);
      return;
    }
    let active = true;
    setPinsLoading(true);
    void loadCountyMapCoords(selected)
      .then((packed) => {
        if (active) setCoords(packed);
      })
      .catch(() => {
        if (active) setCoords(null);
      })
      .finally(() => {
        if (active) setPinsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected]);

  const sites = useMemo(() => {
    const rows = gaps?.sites ?? [];
    if (kind === 'all') return rows;
    return rows.filter((site) => site.kind === kind);
  }, [gaps, kind]);

  const picked = sites.find((site) => siteKey(site) === pickedKey) ?? sites[0] ?? null;
  const mapPoints = useMemo(() => {
    if (!picked) return [] as [number, number][];
    const points: [number, number][] = [[picked.lat, picked.lng]];
    if (picked.nearest_lat != null && picked.nearest_lng != null) {
      points.push([picked.nearest_lat, picked.nearest_lng]);
    }
    return points;
  }, [picked]);

  const focusBounds = useMemo(() => countyBoundsOf(selected), [selected]);
  const presencePins = useMemo(() => {
    if (!focusBounds) return [] as PresencePin[];
    const local = campaignGeo.filter((pin) => inCounty(pin.lat, pin.lng, focusBounds));
    const all = collapsePresencePins(local);
    return all.flatMap((pin) => {
      if (pin.kind === 'volunteer') return layers.volunteers ? [pin] : [];
      if (pin.kind === 'yard_sign') return layers.yardSigns ? [pin] : [];
      if (layers.volunteers && layers.yardSigns) return [pin];
      if (layers.volunteers) return [{ ...pin, kind: 'volunteer' as const }];
      if (layers.yardSigns) return [{ ...pin, kind: 'yard_sign' as const }];
      return [];
    });
  }, [campaignGeo, focusBounds, layers.volunteers, layers.yardSigns]);
  const countyPolls = useMemo(() => {
    const key = countyKey(selected);
    if (!key) return [] as PollMapLocation[];
    return pollLocations.filter(
      (site) =>
        countyKey(site.county) === key &&
        Number.isFinite(site.lat) &&
        Number.isFinite(site.lng),
    );
  }, [pollLocations, selected]);
  const nearestAlreadyPinned = presencePins.some(
    (pin) =>
      picked?.nearest_lat != null &&
      picked.nearest_lng != null &&
      Math.abs(pin.lat - picked.nearest_lat) < 0.0008 &&
      Math.abs(pin.lng - picked.nearest_lng) < 0.0008 &&
      (pin.kind === 'yard_sign' || pin.kind === 'both'),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Polling"
        description="Counties with the most people in the voter file first. Open a county to rank its polling locations from furthest to closest yard sign. Select a location to frame it on the map with nearby voters, yard signs, volunteers, and the other polls in that county."
      />

      {countiesError ? <Alert variant="error">{countiesError}</Alert> : null}

      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <section className="card overflow-hidden">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Counties</h2>
            <p className="text-xs text-slate-500">Ranked by voters in the file</p>
          </div>
          {countiesLoading ? (
            <div className="p-6">
              <Spinner label="Loading counties…" />
            </div>
          ) : counties.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No counties" description="The voter file has no county names yet." />
            </div>
          ) : (
            <ul className="max-h-[70vh] overflow-y-auto">
              {counties.map((county, index) => {
                const on = county.name === selected;
                return (
                  <li key={county.name}>
                    <button
                      type="button"
                      onClick={() => setSelected(county.name)}
                      className={
                        'flex w-full items-baseline justify-between gap-3 px-4 py-2.5 text-left text-sm ' +
                        (on
                          ? 'bg-brand-50 text-brand-900'
                          : 'text-slate-700 hover:bg-slate-50')
                      }
                    >
                      <span className="min-w-0 truncate">
                        <span className="mr-2 tabular-nums text-xs text-slate-400">{index + 1}</span>
                        {county.name}
                      </span>
                      <span className="shrink-0 tabular-nums text-xs text-slate-500">
                        {county.voters.toLocaleString()}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                {selected ? `${selected} County` : 'Polling locations'}
              </h2>
              <p className="text-xs text-slate-500">
                {gaps
                  ? `${gaps.yard_sign_count.toLocaleString()} yard signs on the map` +
                    (gaps.big_yard_sign_count
                      ? `, ${gaps.big_yard_sign_count.toLocaleString()} big`
                      : '') +
                    '. 1 is furthest from a yard sign.'
                  : '1 is furthest from a yard sign.'}
              </p>
            </div>
            <div className="flex flex-wrap gap-1">
              {KIND_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => setKind(filter.id)}
                  className={
                    'rounded-full px-3 py-1 text-xs font-medium ' +
                    (kind === filter.id
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200')
                  }
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>

          {picked ? (
            <div ref={mapAnchor} className="border-b border-slate-200">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs text-slate-500">
                <span>
                  {picked.name}
                  {picked.miles == null
                    ? ' · no yard sign to draw'
                    : ` · ${milesText(picked.miles)} to ${picked.nearest_is_big ? 'a big yard sign' : 'a small yard sign'}`}
                  {' · zoom out for the rest of the county'}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <LayerToggle
                    on={layers.voters}
                    onClick={() => setLayers((prev) => ({ ...prev, voters: !prev.voters }))}
                  >
                    <span className="inline-block h-2 w-2 rounded-full bg-blue-500" />
                    Voters
                  </LayerToggle>
                  <LayerToggle
                    on={layers.yardSigns}
                    onClick={() => setLayers((prev) => ({ ...prev, yardSigns: !prev.yardSigns }))}
                  >
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-sm bg-amber-600 text-[9px] font-bold text-white">
                      YS
                    </span>
                    Signs
                  </LayerToggle>
                  <LayerToggle
                    on={layers.volunteers}
                    onClick={() => setLayers((prev) => ({ ...prev, volunteers: !prev.volunteers }))}
                  >
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-teal-600 text-[9px] font-bold text-white">
                      V
                    </span>
                    Volunteers
                  </LayerToggle>
                  <LayerToggle
                    on={layers.polls}
                    onClick={() => setLayers((prev) => ({ ...prev, polls: !prev.polls }))}
                  >
                    <span className="inline-block h-2.5 w-2 rounded-b-full bg-blue-700" />
                    Other polls
                  </LayerToggle>
                </span>
              </div>
              <div className="relative h-[320px] sm:h-[420px]">
                <MapContainer
                  center={[picked.lat, picked.lng]}
                  zoom={12}
                  scrollWheelZoom
                  style={{ height: '100%', width: '100%' }}
                >
                  <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <FitSelection points={mapPoints} />
                  {layers.voters ? (
                    <VoterClusterLayer
                      coords={coords}
                      bounds={focusBounds}
                      onOpenProfile={setProfileId}
                    />
                  ) : null}
                  {picked.nearest_lat != null && picked.nearest_lng != null ? (
                    <Polyline
                      positions={[
                        [picked.lat, picked.lng],
                        [picked.nearest_lat, picked.nearest_lng],
                      ]}
                      pathOptions={{
                        color: picked.kind === 'election_day' ? '#1d4ed8' : '#d97706',
                        weight: 3,
                        opacity: 0.85,
                      }}
                    />
                  ) : null}
                  <Circle
                    center={[picked.lat, picked.lng]}
                    radius={160}
                    pathOptions={{
                      color: picked.kind === 'election_day' ? '#1d4ed8' : '#d97706',
                      weight: 2,
                      fillOpacity: 0.12,
                      interactive: false,
                    }}
                  />
                  {(layers.polls ? countyPolls : countyPolls.filter(
                    (site) => site.id === picked.id && site.kind === picked.kind,
                  )).map((site) => {
                    const selectedPin = site.id === picked.id && site.kind === picked.kind;
                    return (
                      <Marker
                        key={`poll-${site.kind}-${site.id}`}
                        position={[site.lat, site.lng]}
                        icon={site.kind === 'early_voting' ? earlyIcon : electionIcon}
                        zIndexOffset={selectedPin ? 2000 : site.kind === 'early_voting' ? 1200 : 1000}
                        opacity={selectedPin ? 1 : 0.85}
                      >
                        <Popup>
                          <div className="text-sm">
                            <div className="font-semibold">{site.name}</div>
                            <div>{pollingKindLabel(site.kind)}</div>
                            {selectedPin && placeLine(picked) ? <div>{placeLine(picked)}</div> : null}
                            {selectedPin ? null : (
                              <div className="text-slate-500">
                                {site.assigned_count.toLocaleString()} people matched here
                              </div>
                            )}
                          </div>
                        </Popup>
                      </Marker>
                    );
                  })}
                  {countyPolls.some((site) => site.id === picked.id && site.kind === picked.kind) ? null : (
                    <Marker
                      position={[picked.lat, picked.lng]}
                      icon={picked.kind === 'election_day' ? electionIcon : earlyIcon}
                      zIndexOffset={2000}
                    >
                      <Popup>
                        <div className="text-sm">
                          <div className="font-semibold">{picked.name}</div>
                          <div>{pollingKindLabel(picked.kind)}</div>
                          {placeLine(picked) ? <div>{placeLine(picked)}</div> : null}
                        </div>
                      </Popup>
                    </Marker>
                  )}
                  {presencePins.map((pin, index) => (
                    <Marker
                      key={`p-${pin.kind}-${pin.source_id ?? index}-${pin.lat}-${pin.lng}`}
                      position={[pin.lat, pin.lng]}
                      icon={presenceIcon(pin)}
                      zIndexOffset={pin.kind === 'both' ? 950 : 850}
                    >
                      <Popup>
                        <div className="text-sm">
                          <div className="font-semibold">
                            {pin.kind === 'both'
                              ? pin.is_big
                                ? 'Volunteer + big yard sign'
                                : 'Volunteer + yard sign'
                              : pin.kind === 'yard_sign'
                                ? pin.is_big
                                  ? 'Big yard sign'
                                  : 'Yard sign'
                                : 'Volunteer'}
                          </div>
                          {pin.name ? <div>{pin.name}</div> : null}
                          {pin.address ? <div className="text-slate-500">{pin.address}</div> : null}
                        </div>
                      </Popup>
                    </Marker>
                  ))}
                  {picked.nearest_lat != null &&
                  picked.nearest_lng != null &&
                  !nearestAlreadyPinned ? (
                    <Marker
                      position={[picked.nearest_lat, picked.nearest_lng]}
                      icon={picked.nearest_is_big ? bigYardIcon : yardIcon}
                      zIndexOffset={1400}
                    >
                      <Popup>
                        <div className="text-sm">
                          <div className="font-semibold">
                            {picked.nearest_is_big ? 'Big yard sign' : 'Yard sign'}
                          </div>
                          {picked.nearest_name ? <div>{picked.nearest_name}</div> : null}
                          {picked.nearest_address ? <div>{picked.nearest_address}</div> : null}
                          {picked.miles != null ? (
                            <div>{milesText(picked.miles)} from this poll</div>
                          ) : null}
                        </div>
                      </Popup>
                    </Marker>
                  ) : null}
                </MapContainer>
                {pinsLoading && layers.voters ? (
                  <div className="pointer-events-none absolute inset-x-0 top-0 z-[500] flex items-center justify-center gap-2 bg-white/80 px-3 py-2 text-xs font-medium text-slate-700">
                    <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
                    Plotting voters in {selected}…
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {gapsError ? (
            <div className="p-4">
              <Alert variant="error">{gapsError}</Alert>
            </div>
          ) : null}

          {gapsLoading ? (
            <div className="p-6">
              <Spinner label="Ranking polling locations…" />
            </div>
          ) : !selected ? (
            <div className="p-4">
              <EmptyState title="Choose a county" description="The list ranks that county’s polling locations." />
            </div>
          ) : sites.length === 0 && !gapsError ? (
            <div className="p-4">
              <EmptyState
                title="No polling locations"
                description="This county has no mapped polling locations for that filter."
              />
            </div>
          ) : (
            <ol className="max-h-[55vh] divide-y divide-slate-100 overflow-y-auto">
              {sites.map((site, index) => {
                const election = site.kind === 'election_day';
                const on = picked != null && siteKey(picked) === siteKey(site);
                return (
                  <li key={siteKey(site)}>
                    <button
                      type="button"
                      onClick={() => {
                        setPickedKey(siteKey(site));
                        mapAnchor.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                      }}
                      className={
                        'flex w-full gap-3 px-4 py-3 text-left ' +
                        (on ? 'bg-brand-50' : 'hover:bg-slate-50')
                      }
                    >
                    <span className="w-8 shrink-0 pt-0.5 text-right text-sm font-semibold tabular-nums text-slate-400">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900">{site.name}</span>
                        <span
                          className={
                            'rounded-full px-2 py-0.5 text-[11px] font-semibold ' +
                            (election
                              ? 'bg-blue-50 text-blue-800'
                              : 'bg-amber-50 text-amber-800')
                          }
                        >
                          {pollingKindLabel(site.kind)}
                        </span>
                      </div>
                      {placeLine(site) ? (
                        <p className="mt-0.5 text-sm text-slate-500">{placeLine(site)}</p>
                      ) : null}
                      <p className="mt-1 text-sm text-slate-700">
                        {site.miles == null ? (
                          'No yard signs on the map'
                        ) : (
                          <>
                            <span className="font-medium tabular-nums">{milesText(site.miles)}</span>
                            {' from '}
                            {site.nearest_is_big ? 'a big yard sign' : 'a small yard sign'}
                            {site.nearest_name ? ` (${site.nearest_name})` : ''}
                          </>
                        )}
                      </p>
                    </div>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
      {profileId != null ? (
        <VoterProfileModal voterId={profileId} onClose={() => setProfileId(null)} />
      ) : null}
    </div>
  );
}
