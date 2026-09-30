import { boxAround, type LngLatBounds } from '../core/geo';

export interface Place {
  name: string;
  lng: number;
  lat: number;
  bounds: LngLatBounds;
}

/** Default area around a point result (e.g. a summit): 6 km across. */
const DEFAULT_AREA_M = 6000;

/**
 * Place search via OpenStreetMap Nominatim, limited to the US. Nominatim's usage policy
 * allows light, non-autocomplete use without a key; swap this out before hosting publicly.
 */
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', countrycodes: 'us', limit: '6' });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { signal });
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
  const results: { display_name: string; lat: string; lon: string; boundingbox: [string, string, string, string] }[] =
    await res.json();

  return results.map((r) => {
    const lng = Number(r.lon);
    const lat = Number(r.lat);
    const [s, n, w, e] = r.boundingbox.map(Number);
    // Peaks come back as points; parks and ranges come back with a useful bbox.
    const spanDeg = Math.max(n - s, e - w);
    const bounds = spanDeg > 0.03 && spanDeg < 1 ? { west: w, south: s, east: e, north: n } : boxAround(lng, lat, DEFAULT_AREA_M);
    return { name: r.display_name, lng, lat, bounds };
  });
}
