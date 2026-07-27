import { useEffect, useMemo, useRef } from 'react';
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
import type { MapPoint } from '../lib/types';

export type CampaignMapPin = {
  kind: 'volunteer' | 'yard_sign';
  lat: number;
  lng: number;
  source_id?: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
};

const IDAHO_BOUNDS = L.latLngBounds(
  [41.9, -117.3],
  [49.1, -111.0],
);

const voterIcon = L.divIcon({
  className: '',
  html: `<span style="display:block;width:8px;height:8px;border-radius:9999px;background:#3b82f6;border:1.5px solid #fff;opacity:.85;box-shadow:0 1px 2px rgba(0,0,0,.25)"></span>`,
  iconSize: [8, 8],
  iconAnchor: [4, 4],
  popupAnchor: [0, -4],
});

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
  points,
  campaignGeo = [],
  truncated,
  totalVoters,
}: {
  countyCounts: Record<string, number>;
  focusCounty: string | null;
  onCountyClick: (name: string) => void;
  onClearFocus?: () => void;
  onOpenProfile?: (id: number) => void;
  points: MapPoint[];
  campaignGeo?: CampaignMapPin[];
  truncated: boolean;
  totalVoters: number;
}) {
  const countiesWithVoters = useMemo(
    () => Object.values(countyCounts).filter((n) => n > 0).length,
    [countyCounts],
  );

  const focusBounds = useMemo(
    () => (focusCounty ? countyFeatureBounds(focusCounty) : null),
    [focusCounty],
  );

  // Drop stray voter coords outside the county (they blow out the zoom).
  const localPoints = useMemo(() => {
    if (!focusCounty || !focusBounds) return [] as MapPoint[];
    return points.filter((p) => inBounds(p.lat, p.lng, focusBounds));
  }, [focusCounty, focusBounds, points]);

  const localGeo = useMemo(() => {
    if (!focusCounty || !focusBounds) return [] as CampaignMapPin[];
    return campaignGeo.filter((g) => inBounds(g.lat, g.lng, focusBounds));
  }, [campaignGeo, focusBounds, focusCounty]);

  const yardPins = useMemo(
    () => localGeo.filter((g) => g.kind === 'yard_sign'),
    [localGeo],
  );
  const volPins = useMemo(
    () => localGeo.filter((g) => g.kind === 'volunteer'),
    [localGeo],
  );

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Idaho voter map</h2>
          <p className="text-xs text-slate-500">
            {focusCounty
              ? `${focusCounty} County · ${localPoints.length.toLocaleString()} voter pins` +
                (yardPins.length || volPins.length
                  ? ` · ${yardPins.length} yard signs · ${volPins.length} volunteers`
                  : '') +
                (truncated ? ' (pin set capped)' : '')
              : `${countiesWithVoters} of 44 counties with voters` +
                (totalVoters
                  ? ` · ${totalVoters.toLocaleString()} matching`
                  : '') +
                ' · click a county to zoom & show pins'}
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

      <div className="h-[320px] sm:h-[440px] lg:h-[520px]">
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
            points={localPoints.map((p) => [p.lat, p.lng] as [number, number])}
            presence={localGeo.map((g) => [g.lat, g.lng] as [number, number])}
          />

          <CountyChoropleth
            counts={countyCounts}
            focusCounty={focusCounty}
            onCountyClick={onCountyClick}
          />

          {focusCounty &&
            localPoints.map((p) => (
              <Marker
                key={`v-${p.id}`}
                position={[p.lat, p.lng]}
                icon={voterIcon}
                zIndexOffset={0}
              >
                <Popup>
                  <div className="space-y-1 text-sm">
                    <p className="font-semibold text-slate-800">
                      {[p.first_name, p.last_name].filter(Boolean).join(' ') ||
                        'Unnamed voter'}
                    </p>
                    <p className="text-slate-600">
                      {[p.address_line_1, p.city, p.zip]
                        .filter(Boolean)
                        .join(', ')}
                    </p>
                    {onOpenProfile && (
                      <button
                        type="button"
                        className="mt-1 text-xs font-medium text-brand-600 hover:underline"
                        onClick={() => onOpenProfile(p.id)}
                      >
                        View full profile →
                      </button>
                    )}
                  </div>
                </Popup>
              </Marker>
            ))}

          {/* Presence on top so they stay visible in the clutter */}
          {focusCounty &&
            yardPins.map((g, i) => (
              <Marker
                key={`y-${g.source_id ?? i}-${g.lat}-${g.lng}`}
                position={[g.lat, g.lng]}
                icon={yardIcon}
                zIndexOffset={800}
              >
                <Popup>
                  <PresencePopup kind="Yard sign" pin={g} />
                </Popup>
              </Marker>
            ))}

          {focusCounty &&
            volPins.map((g, i) => (
              <Marker
                key={`vol-${g.source_id ?? i}-${g.lat}-${g.lng}`}
                position={[g.lat, g.lng]}
                icon={volIcon}
                zIndexOffset={900}
              >
                <Popup>
                  <PresencePopup kind="Volunteer" pin={g} />
                </Popup>
              </Marker>
            ))}
        </MapContainer>
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-slate-200 px-4 py-2.5 text-xs text-slate-600">
        {!focusCounty ? (
          <CountyLegend />
        ) : (
          <>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-blue-500" />
              Voters
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-sm bg-amber-600 text-[9px] font-bold text-white">
                YS
              </span>
              Yard signs
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-teal-600 text-[9px] font-bold text-white">
                V
              </span>
              Volunteers
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function PresencePopup({
  kind,
  pin,
}: {
  kind: string;
  pin: CampaignMapPin;
}) {
  return (
    <div className="min-w-[180px] space-y-1 text-sm">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {kind}
      </p>
      <p className="font-semibold text-slate-900">
        {pin.name?.trim() || 'Name not on file'}
      </p>
      {pin.address ? <p className="text-slate-600">{pin.address}</p> : null}
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
  points,
  presence,
}: {
  focusCounty: string | null;
  countyBounds: L.LatLngBounds | null;
  points: [number, number][];
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

    const pinKey = `${focusCounty}:${points.length}:${presence.length}`;
    if (lastKey.current === pinKey) return;
    lastKey.current = pinKey;

    if (points.length === 0 && presence.length === 0) {
      if (countyBounds) {
        map.fitBounds(countyBounds, { padding: [28, 28], maxZoom: 11 });
      }
      return;
    }

    const all = [...points, ...presence];
    if (all.length === 1) {
      map.setView(all[0], 13);
      return;
    }
    map.fitBounds(L.latLngBounds(all), {
      padding: [48, 48],
      maxZoom: 13,
    });
  }, [map, focusCounty, countyBounds, points, presence]);

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
