import { DEP_MAX_PIXELS } from './dem';
import { stlByteLength } from './stl';

export interface PrinterPreset {
  id: string;
  name: string;
  /** Build volume in mm: [x, y, z]. */
  bed: [number, number, number];
}

export const PRINTERS: PrinterPreset[] = [
  { id: 'bambu-a1-mini', name: 'Bambu Lab A1 mini', bed: [180, 180, 180] },
  { id: 'bambu-a1', name: 'Bambu Lab A1', bed: [256, 256, 256] },
  { id: 'bambu-p1s', name: 'Bambu Lab P1S / P1P', bed: [256, 256, 256] },
  { id: 'bambu-x1c', name: 'Bambu Lab X1 Carbon / X1E', bed: [256, 256, 256] },
  { id: 'bambu-h2d', name: 'Bambu Lab H2D', bed: [350, 320, 325] },
  { id: 'prusa-mk4', name: 'Prusa MK4 / MK4S', bed: [250, 210, 220] },
  { id: 'custom', name: 'Custom…', bed: [220, 220, 250] },
];

export const NOZZLES_MM = [0.2, 0.4, 0.6, 0.8];

/**
 * Best horizontal resolution 3DEP can have anywhere (1 m lidar). Many areas only have
 * 10 m, so anything finer than that is interpolated outside lidar coverage.
 */
export const BEST_SOURCE_M = 1;
export const NATIONWIDE_SOURCE_M = 10;

/** Keeps meshes comfortable for the browser, the preview, and slicers (~200 MB STL). */
export const MAX_TRIANGLES = 4_000_000;

export interface RecommendInput {
  groundWidthM: number;
  groundHeightM: number;
  widthMm: number;
  nozzleMm: number;
}

export interface Recommendation {
  cols: number;
  rows: number;
  /** Distance between samples on the printed model. */
  spacingMm: number;
  /** Distance between samples on the ground. */
  groundSpacingM: number;
  triangles: number;
  stlBytes: number;
  limitedBy: 'printer' | 'data' | 'budget' | 'service';
  notes: string[];
}

/**
 * Pick a grid that is as detailed as the printer can reproduce and no more.
 * A nozzle can't render features much smaller than half its width, so sampling
 * finer than nozzle/2 only makes the file bigger.
 */
export function recommend(input: RecommendInput): Recommendation {
  const { groundWidthM, groundHeightM, widthMm, nozzleMm } = input;
  const aspect = groundHeightM / groundWidthM;

  const byPrinter = Math.floor(widthMm / (nozzleMm / 2)) + 1;
  const byData = Math.floor(groundWidthM / BEST_SOURCE_M) + 1;
  const byBudget = Math.floor(Math.sqrt(MAX_TRIANGLES / 2 / aspect)) + 1;
  const byService = Math.floor(Math.min(DEP_MAX_PIXELS, (DEP_MAX_PIXELS - 1) / aspect + 1));

  const limits = { printer: byPrinter, data: byData, budget: byBudget, service: byService };
  let limitedBy: Recommendation['limitedBy'] = 'printer';
  for (const [k, v] of Object.entries(limits)) if (v < limits[limitedBy]) limitedBy = k as typeof limitedBy;

  return describeGrid(input, Math.max(2, limits[limitedBy]), limitedBy);
}

/** Stats and warnings for a given column count (used for both recommended and custom grids). */
export function describeGrid(
  input: RecommendInput,
  cols: number,
  limitedBy: Recommendation['limitedBy'] = 'printer',
): Recommendation {
  const { groundWidthM, groundHeightM, widthMm, nozzleMm } = input;
  const rows = Math.max(2, Math.round(((cols - 1) * groundHeightM) / groundWidthM) + 1);
  const spacingMm = widthMm / (cols - 1);
  const groundSpacingM = groundWidthM / (cols - 1);
  const triangles = 2 * (cols - 1) * (rows - 1) + 6 * (cols + rows - 2);

  const notes: string[] = [];
  if (groundSpacingM < NATIONWIDE_SOURCE_M * 0.99) {
    notes.push(
      `Sampling every ${groundSpacingM.toFixed(1)} m is finer than 3DEP's 10 m nationwide data. ` +
        'Extra detail is real only where 1–3 m lidar exists; elsewhere it is interpolated.',
    );
  }
  if (spacingMm < nozzleMm / 2) {
    notes.push(`Samples are ${spacingMm.toFixed(2)} mm apart, finer than a ${nozzleMm} mm nozzle can print.`);
  }
  if (triangles > MAX_TRIANGLES) notes.push('Very large mesh: generation, preview and slicing will be slow.');
  if (cols > DEP_MAX_PIXELS || rows > DEP_MAX_PIXELS) notes.push(`3DEP allows at most ${DEP_MAX_PIXELS} samples per side.`);

  return { cols, rows, spacingMm, groundSpacingM, triangles, stlBytes: stlByteLength(triangles), limitedBy, notes };
}
