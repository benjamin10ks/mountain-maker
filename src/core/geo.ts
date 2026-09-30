// Web Mercator (EPSG:3857) helpers. 3DEP's ImageServer is natively in 3857, and so is
// the map, so we do all area math in 3857 and convert to ground meters at the end.

const R = 6378137;
const DEG = Math.PI / 180;

export interface LngLatBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface MercatorBounds {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export function lngLatToMercator(lng: number, lat: number): [number, number] {
  return [R * lng * DEG, R * Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2))];
}

export function toMercatorBounds(b: LngLatBounds): MercatorBounds {
  const [xmin, ymin] = lngLatToMercator(b.west, b.south);
  const [xmax, ymax] = lngLatToMercator(b.east, b.north);
  return { xmin, ymin, xmax, ymax };
}

/**
 * Real-world size of an area in meters. Mercator stretches both axes by 1/cos(lat),
 * so scaling by cos(center lat) recovers ground distance. Accurate to well under 1%
 * for areas the size of a mountain.
 */
export function groundSizeMeters(b: LngLatBounds): { widthM: number; heightM: number } {
  const m = toMercatorBounds(b);
  const k = Math.cos(((b.south + b.north) / 2) * DEG);
  return { widthM: (m.xmax - m.xmin) * k, heightM: (m.ymax - m.ymin) * k };
}

/** A square-ish box of `sizeM` meters on each side, centered on a point. */
export function boxAround(lng: number, lat: number, sizeM: number): LngLatBounds {
  const dLat = sizeM / 2 / 111_320;
  const dLng = dLat / Math.cos(lat * DEG);
  return { west: lng - dLng, south: lat - dLat, east: lng + dLng, north: lat + dLat };
}
