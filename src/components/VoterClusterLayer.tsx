import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import type { CountyCoordPayload } from '../lib/mapCoordsCache';

const PAD = 0.1;

function styleForZoom(z: number) {
  if (z < 11) return { r: 1.25, alpha: 0.28, stroke: false };
  if (z < 13) return { r: 2, alpha: 0.4, stroke: false };
  if (z < 15) return { r: 3.25, alpha: 0.75, stroke: true };
  return { r: 4, alpha: 0.9, stroke: true };
}

function inView(
  lat: number,
  lng: number,
  sw: L.LatLng,
  ne: L.LatLng,
): boolean {
  return lat >= sw.lat && lat <= ne.lat && lng >= sw.lng && lng <= ne.lng;
}

function nearestId(
  map: L.Map,
  click: L.LatLng,
  coords: CountyCoordPayload,
  maxPx: number,
): number | null {
  const origin = map.latLngToContainerPoint(click);
  const max = maxPx * maxPx;
  let bestId: number | null = null;
  let best = max;
  const n = Math.min(coords.ids.length, coords.lat.length, coords.lng.length);
  for (let i = 0; i < n; i++) {
    const pt = map.latLngToContainerPoint([coords.lat[i], coords.lng[i]]);
    const d = (pt.x - origin.x) ** 2 + (pt.y - origin.y) ** 2;
    if (d <= best) {
      best = d;
      bestId = coords.ids[i];
    }
  }
  return bestId;
}

type DrawState = {
  center: L.LatLng;
  zoom: number;
};

type LeafletMap = L.Map & {
  _getNewPixelOrigin: (center: L.LatLng, zoom?: number) => L.Point;
};

/** Same math Leaflet uses so the canvas scales around the zoom origin. */
function followZoom(
  map: L.Map,
  canvas: HTMLCanvasElement,
  drawn: DrawState,
  center: L.LatLng,
  zoom: number,
) {
  const scale = map.getZoomScale(zoom, drawn.zoom);
  const viewHalf = map.getSize().multiplyBy(0.5 + PAD);
  const currentCenterPoint = map.project(drawn.center, zoom);
  const topLeftOffset = viewHalf
    .multiplyBy(-scale)
    .add(currentCenterPoint)
    .subtract((map as LeafletMap)._getNewPixelOrigin(center, zoom));
  L.DomUtil.setTransform(canvas, topLeftOffset, scale);
}

function paintDots(
  map: L.Map,
  canvas: HTMLCanvasElement,
  coords: CountyCoordPayload,
  clip: L.LatLngBounds | null,
  drawn: DrawState,
  limit?: number,
) {
  const dpr = window.devicePixelRatio || 1;
  const size = map.getSize();
  const min = map.containerPointToLayerPoint(size.multiplyBy(-PAD)).round();
  const extent = size.multiplyBy(1 + PAD * 2).round();
  const w = Math.max(1, extent.x);
  const h = Math.max(1, extent.y);

  L.DomUtil.setPosition(canvas, min);
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const z = map.getZoom();
  const { r, alpha, stroke } = styleForZoom(z);
  const view = map.getBounds().pad(PAD);
  const sw = view.getSouthWest();
  const ne = view.getNorthEast();
  const n = Math.min(
    coords.ids.length,
    coords.lat.length,
    coords.lng.length,
    limit ?? Number.POSITIVE_INFINITY,
  );

  ctx.fillStyle = `rgba(37, 99, 235, ${alpha})`;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;

  for (let i = 0; i < n; i++) {
    const lat = coords.lat[i];
    const lng = coords.lng[i];
    if (!inView(lat, lng, sw, ne)) continue;
    if (clip && !clip.contains([lat, lng])) continue;
    const pt = map.latLngToLayerPoint([lat, lng]);
    const x = pt.x - min.x;
    const y = pt.y - min.y;
    if (stroke) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }

  drawn.center = map.getCenter();
  drawn.zoom = z;
}

export function VoterClusterLayer({
  coords,
  bounds,
  onOpenProfile,
}: {
  coords: CountyCoordPayload | null;
  bounds?: L.LatLngBounds | null;
  onOpenProfile?: (id: number) => void;
}) {
  const map = useMap();
  const openRef = useRef(onOpenProfile);
  openRef.current = onOpenProfile;
  const coordsRef = useRef(coords);
  coordsRef.current = coords;

  useEffect(() => {
    if (!coords || coords.ids.length === 0) return;

    const canvas = L.DomUtil.create('canvas', 'voter-dot-canvas leaflet-zoom-animated');
    canvas.style.pointerEvents = 'none';
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    map.getPanes().overlayPane.appendChild(canvas);

    const clip = bounds?.pad(0.02) ?? null;
    const drawn: DrawState = {
      center: map.getCenter(),
      zoom: map.getZoom(),
    };
    const total = coords.ids.length;
    let shown = Math.min(total, 12_000);
    let raf = 0;
    const render = () => paintDots(map, canvas, coords, clip, drawn, shown);
    const pump = () => {
      render();
      if (shown < total) {
        shown = Math.min(total, shown + 16_000);
        raf = requestAnimationFrame(pump);
      }
    };
    const onAnimZoom = (e: L.ZoomAnimEvent) => {
      followZoom(map, canvas, drawn, e.center, e.zoom);
    };

    const onClick = (e: L.LeafletMouseEvent) => {
      const packed = coordsRef.current;
      if (!packed) return;
      const hitPx = map.getZoom() >= 14 ? 12 : 7;
      const id = nearestId(map, e.latlng, packed, hitPx);
      if (id != null) openRef.current?.(id);
    };

    pump();
    map.on('moveend', render);
    map.on('zoomend', render);
    map.on('viewreset', render);
    map.on('resize', render);
    map.on('zoomanim', onAnimZoom);
    map.on('click', onClick);
    return () => {
      cancelAnimationFrame(raf);
      map.off('moveend', render);
      map.off('zoomend', render);
      map.off('viewreset', render);
      map.off('resize', render);
      map.off('zoomanim', onAnimZoom);
      map.off('click', onClick);
      canvas.remove();
    };
  }, [map, coords, bounds]);

  return null;
}
