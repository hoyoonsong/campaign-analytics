import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';

type DrawState = {
  center: L.LatLng;
  zoom: number;
};

type LeafletMap = L.Map & {
  _getNewPixelOrigin: (center: L.LatLng, zoom?: number) => L.Point;
};

function followZoom(
  map: L.Map,
  canvas: HTMLCanvasElement,
  drawn: DrawState,
  center: L.LatLng,
  zoom: number,
) {
  const scale = map.getZoomScale(zoom, drawn.zoom);
  const viewHalf = map.getSize().multiplyBy(0.5 + 0.1);
  const currentCenterPoint = map.project(drawn.center, zoom);
  const topLeftOffset = viewHalf
    .multiplyBy(-scale)
    .add(currentCenterPoint)
    .subtract((map as LeafletMap)._getNewPixelOrigin(center, zoom));
  L.DomUtil.setTransform(canvas, topLeftOffset, scale);
}

function paintLinks(
  map: L.Map,
  canvas: HTMLCanvasElement,
  links: number[][],
  color: string,
  drawn: DrawState,
) {
  const dpr = window.devicePixelRatio || 1;
  const size = map.getSize();
  const pad = 0.1;
  const min = map.containerPointToLayerPoint(size.multiplyBy(-pad)).round();
  const extent = size.multiplyBy(1 + pad * 2).round();
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
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const view = map.getBounds().pad(pad);
  for (let i = 0; i < links.length; i++) {
    const lat = links[i][0];
    const lng = links[i][1];
    if (lat == null || lng == null || !view.contains([lat, lng])) continue;
    const pollLat = links[i][2];
    const pollLng = links[i][3];
    if (pollLat == null || pollLng == null) continue;
    const from = map.latLngToLayerPoint([lat, lng]);
    const to = map.latLngToLayerPoint([pollLat, pollLng]);
    ctx.moveTo(from.x - min.x, from.y - min.y);
    ctx.lineTo(to.x - min.x, to.y - min.y);
  }
  ctx.stroke();
  drawn.center = map.getCenter();
  drawn.zoom = map.getZoom();
}

/** Faint lines from each person to their nearest polling site. */
export function PollLinkLayer({
  links,
  color,
}: {
  links: number[][];
  color: string;
}) {
  const map = useMap();
  const linksRef = useRef(links);
  linksRef.current = links;

  useEffect(() => {
    if (links.length === 0) return;
    const canvas = L.DomUtil.create('canvas', 'poll-link-canvas leaflet-zoom-animated');
    canvas.style.pointerEvents = 'none';
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    map.getPanes().overlayPane.appendChild(canvas);

    const drawn: DrawState = {
      center: map.getCenter(),
      zoom: map.getZoom(),
    };
    const render = () => paintLinks(map, canvas, linksRef.current, color, drawn);
    const onAnimZoom = (event: L.ZoomAnimEvent) => {
      followZoom(map, canvas, drawn, event.center, event.zoom);
    };
    render();
    map.on('moveend', render);
    map.on('zoomend', render);
    map.on('viewreset', render);
    map.on('resize', render);
    map.on('zoomanim', onAnimZoom);
    return () => {
      map.off('moveend', render);
      map.off('zoomend', render);
      map.off('viewreset', render);
      map.off('resize', render);
      map.off('zoomanim', onAnimZoom);
      canvas.remove();
    };
  }, [map, links, color]);

  return null;
}
