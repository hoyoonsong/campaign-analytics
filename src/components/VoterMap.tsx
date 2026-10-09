import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  GeoJSON,
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  useMap,
} from 'react-leaflet';
import L from 'leaflet';
import type { GeoJsonObject, Feature, FeatureCollection } from 'geojson';
import 'leaflet/dist/leaflet.css';
import { COUNTY_CENTROIDS, IDAHO_COUNTIES } from '../lib/idahoCounties';
import { fetchPollLinks } from '../lib/api';
import { countyKey, type PollMapLocation } from '../lib/pollingLocations';
import { collapsePresencePins, type PresencePin, type RawPresencePin } from '../lib/presencePins';
import type { CountyCoordPayload } from '../lib/mapCoordsCache';
import { PollLinkLayer } from './PollLinkLayer';
import { VoterClusterLayer } from './VoterClusterLayer';

export type CampaignMapPin = RawPresencePin;

type MapLayers = {
  voters: boolean;
  volunteers: boolean;
  yardSigns: boolean;
  electionDay: boolean;
  earlyVoting: boolean;
  electionLines: boolean;
  earlyLines: boolean;
};

const LAYER_KEY = 'analytics-map-layers-v1';

function loadLayers(): MapLayers {
  const fallback: MapLayers = {
    voters: true,
    volunteers: true,
    yardSigns: true,
    electionDay: true,
    earlyVoting: true,
    electionLines: true,
    earlyLines: false,
  };
  try {
    const raw = localStorage.getItem(LAYER_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<MapLayers>;
    return {
      voters: parsed.voters !== false,
      volunteers: parsed.volunteers !== false,
      yardSigns: parsed.yardSigns !== false,
      electionDay: parsed.electionDay !== false,
      earlyVoting: parsed.earlyVoting !== false,
      electionLines: parsed.electionLines !== false,
      earlyLines: parsed.earlyLines === true,
    };
  } catch {
    return fallback;
  }
}

function saveLayers(layers: MapLayers) {
  try {
    localStorage.setItem(LAYER_KEY, JSON.stringify(layers));
  } catch {
    /* ignore */
  }
}

const IDAHO_BOUNDS = L.latLngBounds(
  [41.9, -117.3],
  [49.1, -111.0],
);

const yardIcon = L.divIcon({
  className: '',
  html: `<span style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:4px;background:#d97706;border:2.5px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.45);font-size:11px;font-weight:800;color:#fff;line-height:1">YS</span>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
  popupAnchor: [0, -12],
});

const volIcon = L.divIcon({
  className: '',
  html: `<span style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:9999px;background:#0d9488;border:2.5px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.45);font-size:10px;font-weight:800;color:#fff;line-height:1">V</span>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
  popupAnchor: [0, -12],
});

/** Election-day polling place: blue map pin. */
const electionIcon = L.divIcon({
  className: '',
  html: `<svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))"><path d="M14 34.5C14 34.5 2.5 20.5 2.5 13.2a11.5 11.5 0 1 1 23 0C25.5 20.5 14 34.5 14 34.5z" fill="#1d4ed8" stroke="#fff" stroke-width="2"/><text x="14" y="16.5" text-anchor="middle" font-size="7" font-weight="800" fill="#fff" font-family="ui-sans-serif,system-ui,sans-serif">POLL</text></svg>`,
  iconSize: [28, 36],
  iconAnchor: [14, 34],
  popupAnchor: [0, -32],
});

/** Early voting: amber diamond, so it never reads as an election-day pin. */
const earlyIcon = L.divIcon({
  className: '',
  html: `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))"><path d="M16 2.5 29.5 16 16 29.5 2.5 16Z" fill="#d97706" stroke="#fff" stroke-width="2"/><text x="16" y="18.5" text-anchor="middle" font-size="6.5" font-weight="800" fill="#fff" font-family="ui-sans-serif,system-ui,sans-serif">EARLY</text></svg>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -16],
});

/** Volunteer + yard sign — one pin so roles never stack. */
const bothIcon = L.divIcon({
  className: '',
  html: `<span style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#0d9488 50%,#d97706 50%);border:2.5px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.45);font-size:8px;font-weight:800;color:#fff;line-height:1;letter-spacing:-0.02em">V+YS</span>`,
  iconSize: [26, 26],
  iconAnchor: [13, 13],
  popupAnchor: [0, -14],
});

function presenceIcon(kind: PresencePin['kind']) {
  if (kind === 'both') return bothIcon;
  if (kind === 'yard_sign') return yardIcon;
  return volIcon;
}

function presenceLabel(kind: PresencePin['kind']) {
  if (kind === 'both') return 'Volunteer + Yard sign';
  if (kind === 'yard_sign') return 'Yard sign';
  return 'Volunteer';
}

function countyFill(count: number): string {
  if (count <= 0) return '#f1f5f9';
  if (count <= 100) return '#bbf7d0';
  if (count <= 500) return '#4ade80';
  if (count <= 2000) return '#16a34a';
  if (count <= 10000) return '#15803d';
  return '#14532d';
}

function countyFeatureBounds(name: string): L.LatLngBounds | null {
  const fc = IDAHO_COUNTIES as unknown as FeatureCollection;
  const feature = fc.features?.find(
    (f) => (f.properties as { name?: string } | null)?.name === name,
  );
  if (!feature) return null;
  return L.geoJSON(feature as Feature).getBounds();
}

function inBounds(
  lat: number,
  lng: number,
  bounds: L.LatLngBounds,
  pad = 0.02,
): boolean {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  return (
    lat >= sw.lat - pad &&
    lat <= ne.lat + pad &&
    lng >= sw.lng - pad &&
    lng <= ne.lng + pad
  );
}

export function VoterMap({
  countyCounts,
  focusCounty,
  onCountyClick,
  onClearFocus,
  onOpenProfile,
  coords,
  campaignGeo = [],
  truncated,
  totalVoters,
  pinsLoading = false,
  pollingLocations = [],
}: {
  countyCounts: Record<string, number>;
  focusCounty: string | null;
  onCountyClick: (name: string) => void;
  onClearFocus?: () => void;
  onOpenProfile?: (id: number) => void;
  coords: CountyCoordPayload | null;
  campaignGeo?: CampaignMapPin[];
  truncated: boolean;
  totalVoters: number;
  pinsLoading?: boolean;
  pollingLocations?: PollMapLocation[];
}) {
  const [layers, setLayers] = useState<MapLayers>(loadLayers);
  const countiesWithVoters = useMemo(
    () => Object.values(countyCounts).filter((n) => n > 0).length,
    [countyCounts],
  );

  const focusBounds = useMemo(
    () => (focusCounty ? countyFeatureBounds(focusCounty) : null),
    [focusCounty],
  );

  // Drop stray voter coords outside the county (they blow out the zoom).
  const voterCount = coords?.ids.length ?? 0;
  const countyTotal = focusCounty ? countyCounts[focusCounty] ?? 0 : 0;
  const headerVoters = voterCount > 0 ? voterCount : countyTotal;

  const localGeo = useMemo(() => {
    if (!focusCounty || !focusBounds) return [] as CampaignMapPin[];
    return campaignGeo.filter((g) => inBounds(g.lat, g.lng, focusBounds));
  }, [campaignGeo, focusBounds, focusCounty]);

  const presencePins = useMemo(() => {
    const all = collapsePresencePins(localGeo);
    return all.flatMap((p) => {
      if (p.kind === 'volunteer') return layers.volunteers ? [p] : [];
      if (p.kind === 'yard_sign') return layers.yardSigns ? [p] : [];
      if (layers.volunteers && layers.yardSigns) return [p];
      if (layers.volunteers) return [{ ...p, kind: 'volunteer' as const }];
      if (layers.yardSigns) return [{ ...p, kind: 'yard_sign' as const }];
      return [];
    });
  }, [localGeo, layers]);
  const yardOnlyCount = presencePins.filter((p) => p.kind === 'yard_sign').length;
  const volOnlyCount = presencePins.filter((p) => p.kind === 'volunteer').length;
  const bothCount = presencePins.filter((p) => p.kind === 'both').length;

  const toggleLayer = (key: keyof MapLayers) => {
    setLayers((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      saveLayers(next);
      return next;
    });
  };

  const focusKey = countyKey(focusCounty);
  const visiblePolls = useMemo(() => {
    if (!focusKey) return [];
    return pollingLocations.filter((site) => {
      if (site.kind === 'election_day' && !layers.electionDay) return false;
      if (site.kind === 'early_voting' && !layers.earlyVoting) return false;
      if (countyKey(site.county) !== focusKey) return false;
      return Number.isFinite(site.lat) && Number.isFinite(site.lng);
    });
  }, [focusKey, layers.electionDay, layers.earlyVoting, pollingLocations]);
  const electionCount = visiblePolls.filter((site) => site.kind === 'election_day').length;
  const earlyCount = visiblePolls.filter((site) => site.kind === 'early_voting').length;

  const [electionLinks, setElectionLinks] = useState<number[][]>([]);
  const [earlyLinks, setEarlyLinks] = useState<number[][]>([]);
  const [linkNote, setLinkNote] = useState<string | null>(null);

  useEffect(() => {
    if (!focusCounty || pollingLocations.length === 0) {
      setElectionLinks([]);
      setEarlyLinks([]);
      setLinkNote(null);
      return;
    }
    let active = true;
    setElectionLinks([]);
    setEarlyLinks([]);
    setLinkNote(null);
    const notes: string[] = [];
    const loadKind = async (
      kind: 'election_day' | 'early_voting',
      enabled: boolean,
    ) => {
      if (!enabled) return [] as number[][];
      try {
        const res = await fetchPollLinks(focusCounty, kind);
        if (res.truncated) {
          notes.push(
            kind === 'election_day'
              ? 'This county has more people than the map can connect to election-day sites. Open a person to see their site.'
              : 'This county has more people than the map can connect to early-voting sites. Open a person to see their site.',
          );
          return [];
        }
        return res.links;
      } catch {
        return [];
      }
    };
    void (async () => {
      const [election, early] = await Promise.all([
        loadKind('election_day', layers.electionLines),
        loadKind('early_voting', layers.earlyLines),
      ]);
      if (!active) return;
      setElectionLinks(election);
      setEarlyLinks(early);
      setLinkNote(notes[0] ?? null);
    })();
    return () => {
      active = false;
    };
  }, [
    focusCounty,
    layers.earlyLines,
    layers.electionLines,
    pollingLocations.length,
  ]);

  const headerDetail = focusCounty
    ? `${focusCounty} County` +
      (pinsLoading && layers.voters
        ? ' · plotting voters…'
        : layers.voters
          ? ` · ${headerVoters.toLocaleString()} voter${headerVoters === 1 ? '' : 's'}`
          : '') +
      (electionCount || earlyCount
        ? ` · ${electionCount.toLocaleString()} election-day polls · ${earlyCount.toLocaleString()} early-voting sites`
        : '') +
      (presencePins.length
        ? ` · ${yardOnlyCount} yard signs · ${volOnlyCount} volunteers` +
          (bothCount ? ` · ${bothCount} both` : '')
        : '') +
      (truncated ? ' (spread sample — snapshot unavailable)' : '')
    : `${countiesWithVoters} of 44 counties with voters` +
      (totalVoters ? ` · ${totalVoters.toLocaleString()} matching` : '') +
      ' · click a county to zoom and show pins';

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Idaho voter map</h2>
          <p className="text-xs text-slate-500">
            {headerDetail}
          </p>
        </div>
        {focusCounty ? (
          <button
            type="button"
            className="btn-ghost px-3 py-1.5 text-sm"
            onClick={() => onClearFocus?.()}
          >
            Show all counties
          </button>
        ) : null}
      </div>

      <div className="relative h-[320px] sm:h-[440px] lg:h-[520px]">
        <MapContainer
          bounds={IDAHO_BOUNDS}
          scrollWheelZoom
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FocusMap
            focusCounty={focusCounty}
            countyBounds={focusBounds}
            truncated={truncated}
            presence={presencePins.map(
              (g) => [g.lat, g.lng] as [number, number],
            )}
          />

          <CountyChoropleth
            counts={countyCounts}
            focusCounty={focusCounty}
            onCountyClick={onCountyClick}
          />

          {focusCounty && layers.voters ? (
            <VoterClusterLayer
              coords={coords}
              bounds={focusBounds}
              onOpenProfile={onOpenProfile}
            />
          ) : null}

          {focusCounty && layers.electionLines && electionLinks.length > 0 ? (
            <PollLinkLayer links={electionLinks} color="rgba(29, 78, 216, 0.55)" />
          ) : null}
          {focusCounty && layers.earlyLines && earlyLinks.length > 0 ? (
            <PollLinkLayer links={earlyLinks} color="rgba(217, 119, 6, 0.7)" />
          ) : null}

          {visiblePolls.map((site) => (
            <Marker
              key={`poll-${site.id}`}
              position={[site.lat, site.lng]}
              icon={site.kind === 'early_voting' ? earlyIcon : electionIcon}
              zIndexOffset={site.kind === 'early_voting' ? 1200 : 1000}
            >
              <Popup>
                <PollPopup site={site} />
              </Popup>
            </Marker>
          ))}

          {focusCounty &&
            presencePins.map((g, i) => (
              <Marker
                key={`p-${g.kind}-${g.source_id ?? i}-${g.lat}-${g.lng}`}
                position={[g.lat, g.lng]}
                icon={presenceIcon(g.kind)}
                zIndexOffset={g.kind === 'both' ? 950 : 850}
              >
                <Popup>
                  <PresencePopup pin={g} />
                </Popup>
              </Marker>
            ))}
        </MapContainer>
        {focusCounty && pinsLoading && layers.voters ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-[500] flex items-center justify-center gap-2 bg-white/80 px-3 py-2 text-xs font-medium text-slate-700">
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
            Plotting voters in {focusCounty}… yard signs and volunteers show first
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-slate-200 px-4 py-2.5 text-xs text-slate-600">
        {!focusCounty ? (
          <CountyLegend />
        ) : (
          <>
            <LayerToggle
              on={layers.voters}
              onClick={() => toggleLayer('voters')}
            >
              <span className="inline-block h-2 w-2 rounded-full bg-blue-500" />
              Voters
            </LayerToggle>
            <LayerToggle
              on={layers.yardSigns}
              onClick={() => toggleLayer('yardSigns')}
            >
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-sm bg-amber-600 text-[9px] font-bold text-white">
                YS
              </span>
              Yard signs
            </LayerToggle>
            <LayerToggle
              on={layers.volunteers}
              onClick={() => toggleLayer('volunteers')}
            >
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-teal-600 text-[9px] font-bold text-white">
                V
              </span>
              Volunteers
            </LayerToggle>
            {layers.volunteers && layers.yardSigns ? (
              <span className="flex items-center gap-1.5 text-slate-500">
                <span
                  className="inline-flex h-4 w-5 items-center justify-center rounded-sm text-[8px] font-bold text-white"
                  style={{
                    background: 'linear-gradient(135deg,#0d9488 50%,#d97706 50%)',
                  }}
                >
                  V+YS
                </span>
                Both
              </span>
            ) : null}
            <span className="text-[11px] text-slate-400">Click to show/hide</span>
          </>
        )}
        {focusCounty && pollingLocations.length > 0 ? (
          <>
            <LayerToggle
              on={layers.electionDay}
              onClick={() => toggleLayer('electionDay')}
            >
              <span className="inline-block h-3.5 w-3 rounded-full bg-blue-700 ring-2 ring-white" />
              Election-day polls
            </LayerToggle>
            <LayerToggle
              on={layers.earlyVoting}
              onClick={() => toggleLayer('earlyVoting')}
            >
              <span className="inline-block h-3 w-3 rotate-45 bg-amber-600 ring-2 ring-white" />
              Early voting
            </LayerToggle>
            {focusCounty ? (
              <>
                <LayerToggle
                  on={layers.electionLines}
                  onClick={() => toggleLayer('electionLines')}
                >
                  <span className="inline-block h-0.5 w-4 bg-blue-700" />
                  Lines to election-day poll
                </LayerToggle>
                <LayerToggle
                  on={layers.earlyLines}
                  onClick={() => toggleLayer('earlyLines')}
                >
                  <span className="inline-block h-0.5 w-4 bg-amber-600" />
                  Lines to early voting
                </LayerToggle>
              </>
            ) : null}
          </>
        ) : null}
        {linkNote ? <span className="text-[11px] text-slate-500">{linkNote}</span> : null}
      </div>
    </div>
  );
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

function PollPopup({ site }: { site: PollMapLocation }) {
  const address = [site.address_line_1, site.city, site.zip].filter(Boolean).join(', ');
  const precincts =
    site.precinct_names && !/^ev$/i.test(site.precinct_names.trim())
      ? site.precinct_names.slice(0, 160)
      : null;
  const people = site.assigned_count.toLocaleString();
  return (
    <div className="min-w-[180px] space-y-1 text-sm">
      <p
        className={`text-[10px] font-semibold uppercase tracking-wide ${
          site.kind === 'early_voting' ? 'text-amber-700' : 'text-blue-700'
        }`}
      >
        {site.kind === 'early_voting' ? 'Early voting' : 'Election-day poll'}
      </p>
      <p className="font-semibold text-slate-900">{site.name}</p>
      {address ? <p className="text-slate-600">{address}</p> : null}
      {site.county ? <p className="text-slate-600">{site.county} County</p> : null}
      {precincts ? <p className="text-xs text-slate-500">{precincts}</p> : null}
      <p className="text-xs text-slate-500">
        Nearest {site.kind === 'early_voting' ? 'early-voting site' : 'election-day poll'} for{' '}
        {people} {site.assigned_count === 1 ? 'person' : 'people'}
      </p>
    </div>
  );
}

function PresencePopup({ pin }: { pin: PresencePin }) {
  const ysNote =
    pin.yard_sign_count && pin.yard_sign_count > 1
      ? `${pin.yard_sign_count} yard signs on file (showing one pin)`
      : null;
  return (
    <div className="min-w-[180px] space-y-1 text-sm">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {presenceLabel(pin.kind)}
      </p>
      <p className="font-semibold text-slate-900">
        {pin.name?.trim() || 'Name not on file'}
      </p>
      {pin.address ? <p className="text-slate-600">{pin.address}</p> : null}
      {ysNote ? <p className="text-xs text-slate-500">{ysNote}</p> : null}
      {pin.phone ? (
        <p className="text-slate-600">
          <a className="text-brand-700 hover:underline" href={`tel:${pin.phone}`}>
            {pin.phone}
          </a>
        </p>
      ) : null}
      {pin.email ? (
        <p className="text-slate-600">
          <a
            className="text-brand-700 hover:underline"
            href={`mailto:${pin.email}`}
          >
            {pin.email}
          </a>
        </p>
      ) : null}
      {!pin.phone && !pin.email && !pin.address ? (
        <p className="text-xs text-slate-400">No contact details synced</p>
      ) : null}
    </div>
  );
}

/**
 * Zoom to county outline while loading, then re-fit to in-county pins once
 * they arrive (never using out-of-county outliers).
 */
function FocusMap({
  focusCounty,
  countyBounds,
  truncated,
  presence,
}: {
  focusCounty: string | null;
  countyBounds: L.LatLngBounds | null;
  truncated: boolean;
  presence: [number, number][];
}) {
  const map = useMap();
  const lastKey = useRef<string>('');

  useEffect(() => {
    if (!focusCounty) {
      if (lastKey.current === 'idaho') return;
      lastKey.current = 'idaho';
      map.fitBounds(IDAHO_BOUNDS, { padding: [10, 10] });
      return;
    }

    const pinKey = `${focusCounty}:${truncated ? 'sample' : 'all'}:${presence.length}`;
    if (lastKey.current === pinKey) return;
    lastKey.current = pinKey;

    if (!truncated && countyBounds) {
      map.fitBounds(countyBounds, { padding: [28, 28], maxZoom: 11 });
      return;
    }

    if (presence.length === 0) {
      if (countyBounds) {
        map.fitBounds(countyBounds, { padding: [28, 28], maxZoom: 11 });
      }
      return;
    }

    if (presence.length === 1) {
      map.setView(presence[0], 13);
      return;
    }
    map.fitBounds(L.latLngBounds(presence), {
      padding: [48, 48],
      maxZoom: 13,
    });
  }, [map, focusCounty, countyBounds, truncated, presence]);

  return null;
}

function CountyChoropleth({
  counts,
  focusCounty,
  onCountyClick,
}: {
  counts: Record<string, number>;
  focusCounty: string | null;
  onCountyClick?: (name: string) => void;
}) {
  const focused = Boolean(focusCounty);
  const geoData = useMemo(() => {
    const fc = IDAHO_COUNTIES as unknown as FeatureCollection;
    if (!focusCounty) return fc as unknown as GeoJsonObject;
    const feature = fc.features?.find(
      (f) => (f.properties as { name?: string } | null)?.name === focusCounty,
    );
    return {
      type: 'FeatureCollection',
      features: feature ? [feature] : [],
    } as unknown as GeoJsonObject;
  }, [focusCounty]);

  const signature = focused
    ? `focus:${focusCounty}`
    : `all:${JSON.stringify(counts)}`;

  return (
    <>
      <GeoJSON
        key={signature}
        data={geoData}
        style={(feature) => {
          const name =
            (feature?.properties as { name: string } | undefined)?.name ?? '';
          if (focused) {
            return {
              fillColor: '#ffffff',
              fillOpacity: 0,
              color: '#1d4ed8',
              weight: 3,
              opacity: 1,
            };
          }
          const count = counts[name] ?? 0;
          return {
            fillColor: countyFill(count),
            fillOpacity: count > 0 ? 0.7 : 0.25,
            color: '#ffffff',
            weight: 1,
          };
        }}
        onEachFeature={(feature, layer) => {
          const name = (feature.properties as { name: string }).name;
          const count = counts[name] ?? 0;
          if (focused) {
            layer.bindTooltip(
              `<strong>${name} County</strong><br/>${count.toLocaleString()} voter${count === 1 ? '' : 's'}`,
              { sticky: true },
            );
            return;
          }
          layer.bindTooltip(
            `<strong>${name} County</strong><br/>${count.toLocaleString()} voter${count === 1 ? '' : 's'}<br/><span style="opacity:.75">Click to zoom &amp; show pins</span>`,
            { sticky: true },
          );
          if (onCountyClick) {
            layer.on({ click: () => onCountyClick(name) });
          }
        }}
      />
      {!focused &&
        Object.entries(counts).map(([name, count]) => {
          const center = COUNTY_CENTROIDS[name];
          if (!center || count === 0) return null;
          return (
            <Marker
              key={name}
              position={center}
              interactive={false}
              icon={L.divIcon({
                className: 'county-count-label',
                html: `<div style="font-weight:700;color:#0f172a;text-shadow:0 0 3px #fff,0 0 3px #fff;font-size:12px">${count.toLocaleString()}</div>`,
                iconSize: [40, 18],
                iconAnchor: [20, 9],
              })}
            />
          );
        })}
    </>
  );
}

function CountyLegend() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-slate-500">Voters / county</span>
      {[
        ['#bbf7d0', '≤100'],
        ['#4ade80', '≤500'],
        ['#16a34a', '≤2k'],
        ['#15803d', '≤10k'],
        ['#14532d', '10k+'],
      ].map(([color, label]) => (
        <span key={label} className="flex items-center gap-1">
          <span
            className="inline-block h-3 w-3 rounded-sm"
            style={{ background: color }}
          />
          {label}
        </span>
      ))}
    </div>
  );
}
