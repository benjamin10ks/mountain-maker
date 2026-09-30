import type { Dem } from './dem';

export interface MeshOptions {
  /** Model size along the east–west axis; north–south follows the area's aspect. */
  widthMm: number;
  exaggeration: number;
  /** Solid thickness under the lowest point of the terrain. */
  baseMm: number;
}

export interface TerrainMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** indices[0, topIndexCount) are the terrain surface; the rest are walls and bottom. */
  topIndexCount: number;
  triangleCount: number;
  sizeMm: [number, number, number];
}

/**
 * Turn a height grid into a closed, manifold solid: the terrain surface, four side
 * walls down to z=0, and a flat bottom. Units are mm, +x east, +y north, +z up, and
 * every triangle is wound counter-clockwise seen from outside (outward normals),
 * which is what slicers expect.
 */
export function buildTerrainMesh(dem: Dem, o: MeshOptions): TerrainMesh {
  const { cols: W, rows: H, heights } = dem;
  if (W < 2 || H < 2) throw new Error('Grid must be at least 2×2');

  const mmPerMeter = o.widthMm / dem.groundWidthM;
  const depthMm = dem.groundHeightM * mmPerMeter;
  const sx = o.widthMm / (W - 1);
  const sy = depthMm / (H - 1);
  const zScale = mmPerMeter * o.exaggeration;

  const ring = perimeter(W, H);
  const P = ring.length;
  const topCount = W * H;
  const center = topCount + P;
  const positions = new Float32Array((topCount + P + 1) * 3);

  // Terrain vertices. Row 0 of the DEM is the north edge, so it gets the largest y.
  let maxZ = 0;
  for (let r = 0; r < H; r++) {
    const y = (H - 1 - r) * sy;
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      const z = o.baseMm + (heights[i] - dem.minM) * zScale;
      positions[i * 3] = c * sx;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      if (z > maxZ) maxZ = z;
    }
  }
  // Bottom ring: a z=0 copy of every perimeter vertex, plus a center point for the bottom fan.
  for (let k = 0; k < P; k++) {
    const src = ring[k] * 3;
    const dst = (topCount + k) * 3;
    positions[dst] = positions[src];
    positions[dst + 1] = positions[src + 1];
  }
  positions[center * 3] = o.widthMm / 2;
  positions[center * 3 + 1] = depthMm / 2;

  const topIndexCount = (W - 1) * (H - 1) * 6;
  const indices = new Uint32Array(topIndexCount + P * 9);
  let n = 0;
  for (let r = 0; r < H - 1; r++) {
    for (let c = 0; c < W - 1; c++) {
      const nw = r * W + c;
      const ne = nw + 1;
      const sw = nw + W;
      const se = sw + 1;
      indices[n++] = sw; indices[n++] = se; indices[n++] = ne;
      indices[n++] = sw; indices[n++] = ne; indices[n++] = nw;
    }
  }
  // The ring runs counter-clockwise seen from above, so "outside" is to the right of travel.
  for (let k = 0; k < P; k++) {
    const k1 = (k + 1) % P;
    const t0 = ring[k], t1 = ring[k1];
    const b0 = topCount + k, b1 = topCount + k1;
    indices[n++] = b0; indices[n++] = b1; indices[n++] = t1; // wall
    indices[n++] = b0; indices[n++] = t1; indices[n++] = t0;
    indices[n++] = center; indices[n++] = b1; indices[n++] = b0; // bottom, facing -z
  }

  return {
    positions,
    indices,
    topIndexCount,
    triangleCount: indices.length / 3,
    sizeMm: [o.widthMm, depthMm, maxZ],
  };
}

/** Grid indices around the edge, counter-clockwise seen from above, starting at the SW corner. */
function perimeter(W: number, H: number): Uint32Array {
  const ring = new Uint32Array(2 * (W + H) - 4);
  let k = 0;
  for (let c = 0; c < W; c++) ring[k++] = (H - 1) * W + c; // south edge, west → east
  for (let r = H - 2; r >= 0; r--) ring[k++] = r * W + W - 1; // east edge, south → north
  for (let c = W - 2; c >= 0; c--) ring[k++] = c; // north edge, east → west
  for (let r = 1; r < H - 1; r++) ring[k++] = r * W; // west edge, north → south
  return ring;
}
