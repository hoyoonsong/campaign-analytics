import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  useMap,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  fetchNearbyPin,
  type NearbyKind,
  type NearbyPinResponse,
} from '../lib/api';
import { Spinner } from './ui';

const voterIcon = L.divIcon({
  className: '',
  html: `<span style="display:block;width:14px;height:14px;border-radius:9999px;background:#2563eb;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.35)"></span>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7],
  popupAnchor: [0, -8],
});

const pinIcon = (kind: NearbyKind) =>
  L.divIcon({
    className: '',
    html: `<span style="display:block;width:14px;height:14px;border-radius:9999px;background:${
      kind === 'yard_sign' ? '#d97706' : '#0284c7'
    };border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.35)"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
    popupAnchor: [0, -8],
  });

function FitPins({
  points,
}: {
  points: Array<[number, number]>;
}) {
  const map = useMap();
  useEffect(() => {
    const t = window.setTimeout(() => map.invalidateSize(), 50);
    if (points.length === 0) return () => window.clearTimeout(t);
    if (points.length === 1) {
      map.setView(points[0], 14);
    } else {
      map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 15 });
    }
    return () => window.clearTimeout(t);
  }, [map, points]);
  return null;
}

function fmtMi(n: number): string {
  return `${n.toFixed(2)} mi`;
}

export function NearbyPinModal({
  voterId,
  kind,
  onClose,
}: {
  voterId: number;
  kind: NearbyKind;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<NearbyPinResponse | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void fetchNearbyPin(voterId, kind)
      .then((r) => {
        if (!active) return;
        setData(r);
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
  }, [voterId, kind]);

  const title =
    kind === 'yard_sign' ? 'Nearest yard sign' : 'Nearest volunteer';

  const pinName = data?.nearest.name?.trim() || 'Unknown';
  const pinAddress = useMemo(() => {
    if (!data) return '—';
    const n = data.nearest;
    if (n.address?.trim()) return n.address.trim();
    return [n.city, n.zip].filter(Boolean).join(', ') || '—';
  }, [data]);

  const body = (
    <div className="fixed inset-0 z-[5000] flex items-start justify-center overflow-y-auto bg-slate-900/40 p-3 sm:p-8">
      <div className="card my-4 w-full max-w-xl overflow-hidden">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
            <p className="text-xs text-slate-500">
              From FormHandler map pins · closest to this voter
              {data?.voter.geocoded ? ' · address geocoded for this lookup' : ''}
            </p>
          </div>
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-sm"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="max-h-[80vh] space-y-4 overflow-y-auto px-4 py-4">
          {loading && <Spinner label="Finding nearest…" />}
          {error && <p className="text-sm text-red-600">{error}</p>}

          {data && !loading && (
            <>
              <section className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {kind === 'yard_sign' ? 'Yard sign contact' : 'Volunteer'}
                </p>
                <p className="mt-0.5 text-base font-semibold text-slate-900">
                  {pinName}
                </p>
                <dl className="mt-2 grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-sm">
                  <dt className="text-slate-500">Distance</dt>
                  <dd className="font-medium text-slate-800">
                    {fmtMi(data.nearest.miles)}
                  </dd>
                  <dt className="text-slate-500">Address</dt>
                  <dd className="text-slate-800">{pinAddress}</dd>
                  <dt className="text-slate-500">Email</dt>
                  <dd className="text-slate-800">{data.nearest.email || '—'}</dd>
                  <dt className="text-slate-500">Phone</dt>
                  <dd className="text-slate-800">{data.nearest.phone || '—'}</dd>
                  {kind === 'yard_sign' && (
                    <>
                      <dt className="text-slate-500">Status</dt>
                      <dd className="capitalize text-slate-800">
                        {data.nearest.status || '—'}
                      </dd>
                      {data.nearest.quantity != null && (
                        <>
                          <dt className="text-slate-500">Qty</dt>
                          <dd className="text-slate-800">
                            {data.nearest.quantity}
                            {data.nearest.is_big ? ' (big)' : ''}
                          </dd>
                        </>
                      )}
                    </>
                  )}
                </dl>
              </section>

              <section>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Map
                </p>
                <div className="h-[280px] overflow-hidden rounded-md border border-slate-200 sm:h-[320px]">
                  <MapContainer
                    center={[data.voter.lat, data.voter.lng]}
                    zoom={13}
                    scrollWheelZoom
                    style={{ height: '100%', width: '100%' }}
                  >
                    <TileLayer
                      attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    />
                    <FitPins
                      points={[
                        [data.voter.lat, data.voter.lng],
                        [data.nearest.lat, data.nearest.lng],
                      ]}
                    />
                    <Marker
                      position={[data.voter.lat, data.voter.lng]}
                      icon={voterIcon}
                    >
                      <Popup>
                        <div className="text-sm">
                          <p className="font-semibold">
                            {[data.voter.first_name, data.voter.last_name]
                              .filter(Boolean)
                              .join(' ') || 'Voter'}
                          </p>
                          <p className="text-slate-600">
                            {[
                              data.voter.address_line_1,
                              data.voter.city,
                              data.voter.zip,
                            ]
                              .filter(Boolean)
                              .join(', ') || 'Voter location'}
                          </p>
                        </div>
                      </Popup>
                    </Marker>
                    <Marker
                      position={[data.nearest.lat, data.nearest.lng]}
                      icon={pinIcon(kind)}
                    >
                      <Popup>
                        <div className="text-sm">
                          <p className="font-semibold">{pinName}</p>
                          <p className="text-slate-600">{pinAddress}</p>
                          <p className="text-slate-500">{fmtMi(data.nearest.miles)}</p>
                        </div>
                      </Popup>
                    </Marker>
                  </MapContainer>
                </div>
                <div className="mt-2 flex flex-wrap gap-4 text-xs text-slate-600">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-blue-600" />
                    Voter
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${
                        kind === 'yard_sign' ? 'bg-amber-600' : 'bg-sky-600'
                      }`}
                    />
                    {kind === 'yard_sign' ? 'Yard sign' : 'Volunteer'}
                  </span>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}
