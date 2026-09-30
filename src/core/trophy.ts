import type { Font } from 'opentype.js';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { buildTerrainBody } from './crop';
import type { Dem } from './dem';
import type { MeshOptions } from './mesh';
import { layoutPlaque, type Vec2 } from './text';

export type Shape = 'rectangle' | 'circle' | 'hexagon';
export type PlinthStyle = 'none' | 'straight' | 'tapered';

export interface TrophyOptions {
  shape: Shape;
  plinth: PlinthStyle;
  plinthHeightMm: number;
  /** Tapered plinths are this much wider at the bottom, e.g. 0.12 = 12%. */
  taper: number;
  text: {
    lines: string[];
    style: 'raised' | 'engraved';
    depthMm: number;
  } | null;
}

export interface Footprint {
  /** Counter-clockwise outline centered on the origin, mm. */
  outline: Vec2[];
  width: number;
  depth: number;
  /** Distance from the center to the flat front (south) face; 0 if there is none. */
  frontY: number;
  frontWidth: number;
}

const COS30 = Math.cos(Math.PI / 6);
const CIRCLE_SEGMENTS = 160;
/** A round plinth with text gets a flat front this far from the center (fraction of R). */
const FLAT_FRONT = 0.8;
/** Overlap between parts so unions weld instead of touching along coplanar faces. */
const EPS = 0.02;

/**
 * The largest shape of the given kind that fits inside a width × depth rectangle.
 * Hexagons have a flat side facing south so there's a face for text.
 */
export function footprint(shape: Shape, width: number, depth: number, flatFront: boolean): Footprint {
  if (shape === 'rectangle') {
    const w = width / 2, d = depth / 2;
    return { outline: [[-w, -d], [w, -d], [w, d], [-w, d]], width, depth, frontY: d, frontWidth: width };
  }
  if (shape === 'hexagon') {
    const R = Math.min(width / 2, depth / (2 * COS30));
    const outline: Vec2[] = [];
    for (let i = 0; i < 6; i++) outline.push([R * Math.cos((i * Math.PI) / 3), R * Math.sin((i * Math.PI) / 3)]);
    return { outline, width: 2 * R, depth: 2 * R * COS30, frontY: R * COS30, frontWidth: R };
  }
  const R = Math.min(width, depth) / 2;
  if (!flatFront) {
    const outline: Vec2[] = [];
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
      const a = (i / CIRCLE_SEGMENTS) * 2 * Math.PI;
      outline.push([R * Math.cos(a), R * Math.sin(a)]);
    }
    return { outline, width: 2 * R, depth: 2 * R, frontY: 0, frontWidth: 0 };
  }
  // "D" shape: an arc from the right end of the front chord, around through north, to the left end.
  const d = FLAT_FRONT * R;
  const a0 = -Math.asin(d / R);
  const a1 = Math.PI - a0;
  const outline: Vec2[] = [];
  const n = Math.ceil((CIRCLE_SEGMENTS * (a1 - a0)) / (2 * Math.PI));
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    outline.push([R * Math.cos(a), R * Math.sin(a)]);
  }
  return { outline, width: 2 * R, depth: R + d, frontY: d, frontWidth: 2 * Math.sqrt(R * R - d * d) };
}

export function hasPlinth(o: TrophyOptions): boolean {
  return o.plinth !== 'none' && o.plinthHeightMm > 0;
}

export function trophyFootprint(o: TrophyOptions, width: number, depth: number): Footprint {
  return footprint(o.shape, width, depth, hasPlinth(o) && !!o.text?.lines.some((l) => l.trim()));
}

/** Scale of the plinth's bottom relative to its top. */
export function plinthScale(o: TrophyOptions): number {
  return o.plinth === 'tapered' ? 1 + o.taper : 1;
}

export interface MeshPart {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface TrophyParts {
  /** Closed solids that overlap slightly; see unionParts() for the single export solid. */
  parts: MeshPart[];
  sizeMm: [number, number, number];
  warnings: string[];
}

/**
 * Build the trophy as separate closed parts: the (cropped) terrain and the plinth with
 * its nameplate. They overlap by EPS, so they print correctly as-is, and unionParts()
 * welds them into one solid for export.
 *
 * Only the plinth goes through the CSG library: it has a few hundred triangles, so text
 * booleans take milliseconds. The terrain is cropped directly (see crop.ts).
 */
export function buildTrophyParts(
  wasm: ManifoldToplevel | null,
  dem: Dem,
  meshOpts: MeshOptions,
  o: TrophyOptions,
  font: Font | null,
  minCapHeightMm = 3,
): TrophyParts {
  const depthMm = (dem.groundHeightM * meshOpts.widthMm) / dem.groundWidthM;
  const plinth = hasPlinth(o);
  const P = plinth ? o.plinthHeightMm : 0;
  const fp = trophyFootprint(o, meshOpts.widthMm, depthMm);
  const warnings: string[] = [];

  const body = buildTerrainBody(dem, meshOpts, o.shape === 'rectangle' ? null : fp.outline, plinth ? P - EPS : 0);
  const parts: MeshPart[] = [{ positions: body.positions, indices: body.indices }];
  if (plinth) {
    if (!wasm) throw new Error('Geometry engine not loaded');
    parts.push(buildPlinth(wasm, fp, o, font, minCapHeightMm, warnings));
  }

  const k = plinthScale(o);
  return { parts, sizeMm: [fp.width * (plinth ? k : 1), fp.depth * (plinth ? k : 1), body.sizeMm[2]], warnings };
}

function buildPlinth(
  wasm: ManifoldToplevel,
  fp: Footprint,
  o: TrophyOptions,
  font: Font | null,
  minCapHeightMm: number,
  warnings: string[],
): MeshPart {
  const { Manifold, CrossSection } = wasm;
  const P = o.plinthHeightMm;
  const k = plinthScale(o);

  // Everything manifold allocates lives in WASM memory and must be freed by hand.
  const owned: { delete(): void }[] = [];
  const own = <T extends { delete(): void }>(x: T): T => (owned.push(x), x);
  try {
    const outline = own(new CrossSection([fp.outline]));
    // scaleTop must be a [x, y] pair: manifold-3d 3.5 treats a bare number as [n, 0] and
    // collapses the top to a line (the types say a number is fine).
    let body = own(Manifold.extrude(own(outline.scale(k)), P, 0, 0, [1 / k, 1 / k]));

    const lines = o.text?.lines.filter((l) => l.trim()) ?? [];
    if (o.text && lines.length && font && fp.frontWidth > 0) {
      // The front face leans back by θ on a tapered plinth.
      const theta = Math.atan((fp.frontY * (k - 1)) / P);
      const faceHeight = P / Math.cos(theta);
      const layout = layoutPlaque(font, lines, fp.frontWidth * 0.85, faceHeight * 0.7);
      if (layout.capHeights.some((h) => h < minCapHeightMm)) {
        warnings.push(
          `Smallest letters are ${Math.min(...layout.capHeights).toFixed(1)} mm tall; under ` +
            `${minCapHeightMm} mm may not print legibly. Shorten the text or raise the plinth.`,
        );
      }
      const depth = o.text.depthMm;
      const letters = own(new CrossSection(layout.contours, 'NonZero'));
      // Extrude along +z, then stand the letters up on the front face: rotating 90° about x
      // sends the extrusion to −y (outward) and the text's up to +z.
      let plate = own(Manifold.extrude(letters, depth + EPS));
      plate = own(plate.translate(0, 0, o.text.style === 'raised' ? -EPS : -depth));
      plate = own(plate.rotate([90, 0, 0]));
      plate = own(plate.rotate([(-theta * 180) / Math.PI, 0, 0]));
      plate = own(plate.translate(0, (-fp.frontY * (1 + k)) / 2, P / 2));
      body = own(o.text.style === 'raised' ? Manifold.union(body, plate) : body.subtract(plate));
    } else if (o.text && lines.length && fp.frontWidth === 0) {
      warnings.push('This shape has no flat face for text.');
    }
    return toPart(body);
  } finally {
    for (const x of owned) x.delete();
  }
}

/** Weld parts into one watertight solid for export. */
export function unionParts(wasm: ManifoldToplevel | null, parts: MeshPart[]): MeshPart {
  if (parts.length === 1) return parts[0];
  if (!wasm) throw new Error('Geometry engine not loaded');
  const { Manifold, Mesh } = wasm;
  const solids = parts.map((p) => new Manifold(new Mesh({ numProp: 3, vertProperties: p.positions, triVerts: p.indices })));
  const all = Manifold.union(solids);
  try {
    return toPart(all);
  } finally {
    all.delete();
    for (const s of solids) s.delete();
  }
}

function toPart(m: Manifold): MeshPart {
  const status = m.status();
  if (status !== 'NoError') throw new Error(`Geometry failed: ${status}`);
  const mesh = m.getMesh();
  const positions = new Float32Array((mesh.vertProperties.length / mesh.numProp) * 3);
  for (let v = 0, i = 0; i < positions.length; v += mesh.numProp, i += 3) {
    positions[i] = mesh.vertProperties[v];
    positions[i + 1] = mesh.vertProperties[v + 1];
    positions[i + 2] = mesh.vertProperties[v + 2];
  }
  return { positions, indices: new Uint32Array(mesh.triVerts) };
}

/** Concatenate parts into one indexed mesh (for the preview). */
export function mergeParts(parts: MeshPart[]): MeshPart {
  const positions = new Float32Array(parts.reduce((n, p) => n + p.positions.length, 0));
  const indices = new Uint32Array(parts.reduce((n, p) => n + p.indices.length, 0));
  let pOff = 0, iOff = 0;
  for (const p of parts) {
    positions.set(p.positions, pOff);
    for (let i = 0; i < p.indices.length; i++) indices[iOff + i] = p.indices[i] + pOff / 3;
    pOff += p.positions.length;
    iOff += p.indices.length;
  }
  return { positions, indices };
}
