import { fetchMapSnapshot } from './api';

const DB_NAME = 'campaign-map-coords';
const STORE = 'counties';
const DB_VERSION = 1;

export type CountyCoordPayload = {
  version: number;
  ids: number[];
  lat: number[];
  lng: number[];
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

async function idbGet(county: string): Promise<CountyCoordPayload | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(county);
      req.onsuccess = () => {
        const v = req.result as CountyCoordPayload | undefined;
        resolve(v && Array.isArray(v.ids) && Array.isArray(v.lat) ? v : null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbPut(county: string, payload: CountyCoordPayload) {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(payload, county);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* private mode / quota */
  }
}

/** Load county voter coords from IndexedDB, or the server snapshot if stale/missing. */
export async function loadCountyMapCoords(
  county: string,
): Promise<CountyCoordPayload & { fromCache: boolean }> {
  const cached = await idbGet(county);
  const snap = await fetchMapSnapshot(county, cached?.version ?? null);

  if (snap.unchanged && cached && cached.ids.length === (snap.count ?? cached.ids.length)) {
    return { ...cached, fromCache: true };
  }

  if (snap.unchanged && !cached) {
    const fresh = await fetchMapSnapshot(county, null);
    return storeSnap(county, fresh, false);
  }

  return storeSnap(county, snap, false);
}

function storeSnap(
  county: string,
  snap: {
    version?: number;
    ids?: number[];
    lat?: number[];
    lng?: number[];
  },
  fromCache: boolean,
) {
  const payload: CountyCoordPayload = {
    version: Number(snap.version) || 0,
    ids: Array.isArray(snap.ids) ? snap.ids.map(Number) : [],
    lat: Array.isArray(snap.lat) ? snap.lat.map(Number) : [],
    lng: Array.isArray(snap.lng) ? snap.lng.map(Number) : [],
  };
  void idbPut(county, payload);
  return { ...payload, fromCache };
}
