import { fromArrayBuffer } from 'geotiff';
import { groundSizeMeters, toMercatorBounds, type LngLatBounds } from './geo';

// USGS 3DEP dynamic elevation service. exportImage resamples the best available
// source (1 m lidar where it exists, 10 m nationwide) to whatever grid we ask for,
// and it sends `Access-Control-Allow-Origin: *`, so the browser can call it directly.
export const DEP_EXPORT_URL =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';

/** The service rejects requests larger than this in either dimension. */
export const DEP_MAX_PIXELS = 8000;

export interface Dem {
  /** Row-major heights in meters, row 0 = north edge. */
  heights: Float32Array;
  cols: number;
  rows: number;
  groundWidthM: number;
  groundHeightM: number;
  minM: number;
  maxM: number;
}

export async function fetchDem(
  bounds: LngLatBounds,
  cols: number,
  rows: number,
  signal?: AbortSignal,
): Promise<Dem> {
  if (cols > DEP_MAX_PIXELS || rows > DEP_MAX_PIXELS) {
    throw new Error(`3DEP allows at most ${DEP_MAX_PIXELS}×${DEP_MAX_PIXELS} samples per request`);
  }
  const m = toMercatorBounds(bounds);
  // The grid must have the same aspect ratio as the bbox: if it doesn't, the server
  // silently grows the extent to fit, and the model would cover the wrong area.
  const params = new URLSearchParams({
    bbox: [m.xmin, m.ymin, m.xmax, m.ymax].join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${cols},${rows}`,
    format: 'tiff',
    pixelType: 'F32',
    interpolation: 'RSP_BilinearInterpolation',
    f: 'image',
  });
  const res = await fetch(`${DEP_EXPORT_URL}?${params}`, { signal });
  if (!res.ok) throw new Error(`3DEP request failed: HTTP ${res.status}`);
  if (!res.headers.get('content-type')?.includes('tiff')) {
    // ArcGIS reports errors as a 200 with a JSON body.
    throw new Error(`3DEP returned an error: ${(await res.text()).slice(0, 200)}`);
  }

  const tiff = await fromArrayBuffer(await res.arrayBuffer());
  const image = await tiff.getImage();
  if (image.getWidth() !== cols || image.getHeight() !== rows) {
    throw new Error(`Expected ${cols}×${rows} from 3DEP, got ${image.getWidth()}×${image.getHeight()}`);
  }
  const [band] = await image.readRasters();
  const heights = cleanHeights(Float32Array.from(band as ArrayLike<number>));

  let minM = Infinity;
  let maxM = -Infinity;
  for (const h of heights) {
    if (h < minM) minM = h;
    if (h > maxM) maxM = h;
  }
  const { widthM, heightM } = groundSizeMeters(bounds);
  return { heights, cols, rows, groundWidthM: widthM, groundHeightM: heightM, minM, maxM };
}

/**
 * Replace missing samples with the lowest valid height. 3DEP returns 0 over open
 * ocean, but other gaps can come back as NaN or as float-min sentinels.
 */
export function cleanHeights(heights: Float32Array): Float32Array {
  const valid = (h: number) => Number.isFinite(h) && h > -500 && h < 9000;
  let floor = Infinity;
  for (const h of heights) if (valid(h) && h < floor) floor = h;
  if (floor === Infinity) throw new Error('No elevation data for this area (is it inside the US?)');
  for (let i = 0; i < heights.length; i++) if (!valid(heights[i])) heights[i] = floor;
  return heights;
}
