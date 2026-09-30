import type { Dem } from './dem';
import { buildTerrainMesh, type MeshOptions, type TerrainMesh } from './mesh';
import type { Vec2 } from './text';

/**
 * Terrain solid centered on the origin with its bottom at `zBottom`, optionally cropped
 * to a convex outline (circle, hexagon, …).
 *
 * Cropping is done directly on the height grid rather than with a CSG library: cells
 * fully inside are kept, cells on the edge are clipped against the outline
 * (Sutherland–Hodgman), and walls are dropped from the cut edge. This is ~50× faster
 * than a boolean on a 700k-triangle mesh, which keeps live tweaks interactive.
 */
export function buildTerrainBody(dem: Dem, o: MeshOptions, outline: Vec2[] | null, zBottom: number): TerrainMesh {
  if (!outline) {
    const m = buildTerrainMesh(dem, o);
    const [w, d] = m.sizeMm;
    for (let i = 0; i < m.positions.length; i += 3) {
      m.positions[i] -= w / 2;
      m.positions[i + 1] -= d / 2;
      m.positions[i + 2] += zBottom;
    }
    m.sizeMm[2] += zBottom;
    return m;
  }
  return buildCropped(dem, o, outline, zBottom);
}

function buildCropped(dem: Dem, o: MeshOptions, outline: Vec2[], zBottom: number): TerrainMesh {
  const { cols: W, rows: H, heights } = dem;
  const mmPerMeter = o.widthMm / dem.groundWidthM;
  const depthMm = dem.groundHeightM * mmPerMeter;
  const sx = o.widthMm / (W - 1);
  const sy = depthMm / (H - 1);
  const zScale = mmPerMeter * o.exaggeration;
  const zTop = zBottom + o.baseMm;
  const V = W * H;

  // Shrink the outline a hair and nudge it off the grid so no grid vertex or grid line
  // ever lands exactly on it (shapes inscribed in the area touch its border otherwise).
  const poly = outline.map(([x, y]): Vec2 => [x * (1 - 1e-4) + sx * 1.37e-5, y * (1 - 1e-4) + sy * 0.73e-5]);
  const N = poly.length;
  // side(e, x, y) > 0 ⇔ (x, y) is on the inner side of outline edge e (outline is CCW).
  const ex = new Float64Array(N), ey = new Float64Array(N), dx = new Float64Array(N), dy = new Float64Array(N);
  let rIn = Infinity, rOut = 0;
  for (let e = 0; e < N; e++) {
    const [ax, ay] = poly[e];
    const [bx, by] = poly[(e + 1) % N];
    ex[e] = ax; ey[e] = ay; dx[e] = bx - ax; dy[e] = by - ay;
    rIn = Math.min(rIn, (dx[e] * -ay - dy[e] * -ax) / Math.hypot(dx[e], dy[e]));
    rOut = Math.max(rOut, Math.hypot(ax, ay));
  }
  const side = (e: number, x: number, y: number) => dx[e] * (y - ey[e]) - dy[e] * (x - ex[e]);

  const colX = new Float64Array(W), rowY = new Float64Array(H);
  for (let c = 0; c < W; c++) colX[c] = c * sx - o.widthMm / 2;
  for (let r = 0; r < H; r++) rowY[r] = (H - 1 - r) * sy - depthMm / 2;
  const gx = (v: number) => colX[v % W];
  const gy = (v: number) => rowY[(v / W) | 0];
  const gz = (v: number) => zTop + (heights[v] - dem.minM) * zScale;

  const rIn2 = rIn * rIn, rOut2 = rOut * rOut;
  const inside = new Uint8Array(V);
  for (let r = 0, v = 0; r < H; r++) {
    const y = rowY[r];
    for (let c = 0; c < W; c++, v++) {
      const x = colX[c], d2 = x * x + y * y;
      if (d2 < rIn2) inside[v] = 1;
      else if (d2 <= rOut2) {
        let ok = 1;
        for (let e = 0; e < N && ok; e++) if (side(e, x, y) <= 0) ok = 0;
        inside[v] = ok;
      }
    }
  }

  // Output vertices 0..V−1 are the grid (unused ones are compacted away at the end);
  // new vertices on the cut come after, keyed by the two lines that make them so
  // neighbouring cells share them exactly.
  const extra: number[] = [];
  const keyed = new Map<string, number>();
  const interior = new Uint32Array((W - 1) * (H - 1) * 6);
  let nInterior = 0;
  const tris: number[] = [];
  const edgeFrom: number[] = [];
  const edgeTo: number[] = [];

  // A clipped-polygon vertex: either a grid vertex or a keyed point on the cut.
  interface P { x: number; y: number; z: number; grid: number; key: string }
  const gridPoint = (v: number): P => ({ x: gx(v), y: gy(v), z: gz(v), grid: v, key: '' });
  const indexOf = (p: P) => {
    if (p.grid >= 0) return p.grid;
    let i = keyed.get(p.key);
    if (i === undefined) {
      i = V + extra.length / 3;
      keyed.set(p.key, i);
      extra.push(p.x, p.y, p.z);
    }
    return i;
  };

  // Lines are grid edges (id ≥ 0, from their two vertices) or outline edges (id = −e − 1).
  const gridLine = (u: number, v: number) => Math.min(u, v) * V + Math.max(u, v);
  const clipTriangle = (a: number, b: number, c: number) => {
    const A = gridPoint(a), B = gridPoint(b), C = gridPoint(c);
    let pts: P[] = [A, B, C];
    let lines = [gridLine(a, b), gridLine(b, c), gridLine(c, a)];
    // Height of a point inside this triangle (for outline corners).
    const det = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
    const baryZ = (x: number, y: number) => {
      const l1 = ((B.y - C.y) * (x - C.x) + (C.x - B.x) * (y - C.y)) / det;
      const l2 = ((C.y - A.y) * (x - C.x) + (A.x - C.x) * (y - C.y)) / det;
      return l1 * A.z + l2 * B.z + (1 - l1 - l2) * C.z;
    };
    const cross = (line: number, e: number): P => {
      if (line >= 0) {
        // Always computed from the original grid edge so both neighbours agree exactly.
        const u = Math.floor(line / V), v = line % V;
        const su = side(e, gx(u), gy(u)), sv = side(e, gx(v), gy(v));
        const t = su / (su - sv);
        return {
          x: gx(u) + t * (gx(v) - gx(u)),
          y: gy(u) + t * (gy(v) - gy(u)),
          z: gz(u) + t * (gz(v) - gz(u)),
          grid: -1,
          key: `g${line}:${e}`,
        };
      }
      // Two outline edges meet at a corner of the outline.
      const f = -line - 1;
      const den = dx[f] * dy[e] - dy[f] * dx[e];
      const t = ((ex[e] - ex[f]) * dy[e] - (ey[e] - ey[f]) * dx[e]) / den;
      const x = ex[f] + t * dx[f], y = ey[f] + t * dy[f];
      return { x, y, z: baryZ(x, y), grid: -1, key: `c${Math.min(e, f)}:${Math.max(e, f)}` };
    };

    for (let e = 0; e < N && pts.length; e++) {
      // The clipped polygon stays inside the triangle, so an edge that has the whole
      // triangle on its inner side can't cut it. That's all but one or two edges.
      if (side(e, A.x, A.y) > 0 && side(e, B.x, B.y) > 0 && side(e, C.x, C.y) > 0) continue;
      const s = pts.map((p) => side(e, p.x, p.y));
      if (s.every((v) => v > 0)) continue;
      const nextPts: P[] = [];
      const nextLines: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        if (s[i] > 0) {
          nextPts.push(pts[i]);
          nextLines.push(lines[i]);
          if (s[j] <= 0) {
            nextPts.push(cross(lines[i], e));
            nextLines.push(-e - 1);
          }
        } else if (s[j] > 0) {
          nextPts.push(cross(lines[i], e));
          nextLines.push(lines[i]);
        }
      }
      pts = nextPts;
      lines = nextLines;
    }
    if (pts.length < 3) return;

    const idx = pts.map(indexOf);
    for (let k = 1; k < idx.length - 1; k++) tris.push(idx[0], idx[k], idx[k + 1]);
    for (let k = 0; k < idx.length; k++) {
      if (lines[k] < 0) {
        edgeFrom.push(idx[k]);
        edgeTo.push(idx[(k + 1) % idx.length]);
      }
    }
  };

  // Every point of a cell triangle is within one diagonal of each of its corners.
  const reach = rOut + Math.hypot(sx, sy);
  const reach2 = reach * reach;
  const near = (v: number) => gx(v) ** 2 + gy(v) ** 2 <= reach2;
  for (let r = 0; r < H - 1; r++) {
    for (let c = 0; c < W - 1; c++) {
      const nw = r * W + c, ne = nw + 1, sw = nw + W, se = sw + 1;
      if (inside[sw] && inside[se] && inside[ne]) {
        interior[nInterior++] = sw; interior[nInterior++] = se; interior[nInterior++] = ne;
      } else if (near(sw)) clipTriangle(sw, se, ne);
      if (inside[sw] && inside[ne] && inside[nw]) {
        interior[nInterior++] = sw; interior[nInterior++] = ne; interior[nInterior++] = nw;
      } else if (near(sw)) clipTriangle(sw, ne, nw);
    }
  }

  // The cut edges form one counter-clockwise loop (seen from above) around the outline.
  const next = new Map<number, number>();
  for (let i = 0; i < edgeFrom.length; i++) next.set(edgeFrom[i], edgeTo[i]);
  const ring: number[] = [edgeFrom[0]];
  for (let v = next.get(ring[0])!; v !== ring[0]; v = next.get(v)!) {
    if (v === undefined || ring.length > edgeFrom.length) throw new Error('Crop failed: outline is not closed');
    ring.push(v);
  }
  if (ring.length !== edgeFrom.length) throw new Error('Crop failed: outline has more than one loop');

  // Compact: keep only referenced vertices (grid vertices outside the outline drop out).
  const nExtra = extra.length / 3;
  const remap = new Int32Array(V + nExtra).fill(-1);
  const P = ring.length;
  let nv = 0;
  const use = (v: number) => {
    if (remap[v] < 0) remap[v] = nv++;
  };
  for (let i = 0; i < nInterior; i++) use(interior[i]);
  for (const v of tris) use(v);
  const positions = new Float32Array((nv + P + 1) * 3);
  for (let v = 0; v < V + nExtra; v++) {
    const i = remap[v];
    if (i < 0) continue;
    if (v < V) {
      positions[i * 3] = gx(v); positions[i * 3 + 1] = gy(v); positions[i * 3 + 2] = gz(v);
    } else {
      const e = (v - V) * 3;
      positions[i * 3] = extra[e]; positions[i * 3 + 1] = extra[e + 1]; positions[i * 3 + 2] = extra[e + 2];
    }
  }

  // Walls down to zBottom and a bottom fanned from the center, as in buildTerrainMesh.
  const topIndexCount = nInterior + tris.length;
  const indices = new Uint32Array(topIndexCount + P * 9);
  for (let i = 0; i < nInterior; i++) indices[i] = remap[interior[i]];
  for (let i = 0; i < tris.length; i++) indices[nInterior + i] = remap[tris[i]];
  const center = nv + P;
  for (let k = 0; k < P; k++) {
    const t = remap[ring[k]] * 3, b = (nv + k) * 3;
    positions[b] = positions[t]; positions[b + 1] = positions[t + 1]; positions[b + 2] = zBottom;
  }
  positions[center * 3 + 2] = zBottom;
  let n = topIndexCount;
  for (let k = 0; k < P; k++) {
    const k1 = (k + 1) % P;
    const t0 = remap[ring[k]], t1 = remap[ring[k1]], b0 = nv + k, b1 = nv + k1;
    indices[n++] = b0; indices[n++] = b1; indices[n++] = t1;
    indices[n++] = b0; indices[n++] = t1; indices[n++] = t0;
    indices[n++] = center; indices[n++] = b1; indices[n++] = b0;
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxZ = 0;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
    maxZ = Math.max(maxZ, positions[i + 2]);
  }
  return {
    positions,
    indices,
    topIndexCount,
    triangleCount: indices.length / 3,
    sizeMm: [maxX - minX, maxY - minY, maxZ],
  };
}
