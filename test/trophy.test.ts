import { readFileSync } from 'node:fs';
import Module from 'manifold-3d';
import { parse } from 'opentype.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Dem } from '../src/core/dem';
import { buildTerrainBody } from '../src/core/crop';
import { layoutPlaque } from '../src/core/text';
import { buildTrophyParts, footprint, unionParts, type TrophyOptions } from '../src/core/trophy';

type Wasm = Awaited<ReturnType<typeof Module>>;
let wasm: Wasm;
const fontBuf = readFileSync('node_modules/@fontsource/oswald/files/oswald-latin-700-normal.woff');
const font = parse(fontBuf.buffer.slice(fontBuf.byteOffset, fontBuf.byteOffset + fontBuf.byteLength));

beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

function dem(n: number, rows = n): Dem {
  const heights = new Float32Array(n * rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < n; c++) {
      const dx = c / (n - 1) - 0.5, dy = r / (rows - 1) - 0.5;
      heights[r * n + c] = 1500 + 2500 * Math.exp(-(dx * dx + dy * dy) * 12) + 40 * Math.sin(c / 5);
    }
  let minM = Infinity, maxM = -Infinity;
  for (const h of heights) { minM = Math.min(minM, h); maxM = Math.max(maxM, h); }
  return { heights, cols: n, rows, groundWidthM: 6000, groundHeightM: (6000 * (rows - 1)) / (n - 1), minM, maxM };
}

/** Closed, consistently wound, positive volume. */
function expectSolid(positions: Float32Array, indices: Uint32Array) {
  const edges = new Set<string>();
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const key = `${indices[t + k]}>${indices[t + ((k + 1) % 3)]}`;
      expect(edges.has(key), `duplicate edge ${key}`).toBe(false);
      edges.add(key);
    }
  for (const key of edges) {
    const [a, b] = key.split('>');
    expect(edges.has(`${b}>${a}`), `open edge ${key}`).toBe(true);
  }
  let vol = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    const p = positions;
    vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  expect(vol).toBeGreaterThan(0);
  return vol;
}

function bbox(p: Float32Array) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]); }
  return { min, max };
}

const base: TrophyOptions = { shape: 'rectangle', plinth: 'none', plinthHeightMm: 15, taper: 0.12, text: null };
const text = { lines: ['Mount Rainier', '14,411 ft · 2026'], style: 'raised' as const, depthMm: 0.8 };

describe('footprint', () => {
  it('fits each shape inside the selection', () => {
    for (const shape of ['rectangle', 'circle', 'hexagon'] as const) {
      const fp = footprint(shape, 120, 100, true);
      for (const [x, y] of fp.outline) {
        expect(Math.abs(x)).toBeLessThanOrEqual(60 + 1e-9);
        expect(Math.abs(y)).toBeLessThanOrEqual(50 + 1e-9);
      }
      expect(fp.frontWidth).toBeGreaterThan(0);
    }
  });
});

describe('layoutPlaque', () => {
  it('fits the text box and keeps holes in letters', () => {
    const { contours, capHeights } = layoutPlaque(font, ['MOUNT RAINIER', '14,411 FT'], 100, 12);
    expect(capHeights[1]).toBeLessThan(capHeights[0]);
    const xs = contours.flat().map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(100.5);
    // "O" has a counter: filled area must be less than its outer contour's area.
    const O = new wasm.CrossSection(layoutPlaque(font, ['O'], 50, 50).contours, 'NonZero');
    const outer = new wasm.CrossSection([layoutPlaque(font, ['O'], 50, 50).contours[0]], 'NonZero');
    expect(O.area()).toBeLessThan(outer.area() * 0.95);
    O.delete(); outer.delete();
  });
});

const meshOpts = { widthMm: 120, exaggeration: 1.5, baseMm: 3 };

describe('buildTerrainBody (crop)', () => {
  const shapes: [string, 'circle' | 'hexagon', boolean][] = [['circle', 'circle', false], ['D', 'circle', true], ['hexagon', 'hexagon', true]];
  for (const [name, shape, flat] of shapes) {
    for (const [cols, rows] of [[40, 40], [61, 37], [7, 9]]) {
      it(`${name} crop of a ${cols}×${rows} grid is a closed solid`, () => {
        const d = dem(cols, rows);
        const depth = (d.groundHeightM * 120) / d.groundWidthM;
        const fp = footprint(shape, 120, depth, flat);
        const body = buildTerrainBody(d, meshOpts, fp.outline, 4);
        const vol = expectSolid(body.positions, body.indices);
        const { min, max } = bbox(body.positions);
        expect(min[2]).toBeCloseTo(4, 5);
        expect(max[0] - min[0]).toBeCloseTo(fp.width, 1);
        expect(max[1] - min[1]).toBeCloseTo(fp.depth, 1);
        // Volume is at least the footprint area × base thickness.
        const area = new wasm.CrossSection([fp.outline]);
        expect(vol).toBeGreaterThan(area.area() * meshOpts.baseMm);
        area.delete();
      });
    }
  }
});

describe('buildTrophyParts', () => {
  const d = dem(120);

  const cases: [string, Partial<TrophyOptions>][] = [
    ['rectangle, no plinth', {}],
    ['circle crop', { shape: 'circle' }],
    ['hexagon on straight plinth with raised text', { shape: 'hexagon', plinth: 'straight', text }],
    ['circle on tapered plinth with engraved text', { shape: 'circle', plinth: 'tapered', text: { ...text, style: 'engraved' } }],
    ['rectangle on tapered plinth with raised text', { plinth: 'tapered', text }],
  ];
  for (const [name, opts] of cases) {
    it(`parts and welded export are printable solids: ${name}`, () => {
      const r = buildTrophyParts(wasm, d, meshOpts, { ...base, ...opts }, font);
      for (const p of r.parts) expectSolid(p.positions, p.indices);
      const solid = unionParts(wasm, r.parts);
      expectSolid(solid.positions, solid.indices);
      const { min, max } = bbox(solid.positions);
      expect(min[2]).toBeCloseTo(0, 3);
      expect(Math.abs(min[0] + max[0])).toBeLessThan(2); // centered
    });
  }

  const plinthOnly = (o: TrophyOptions) => buildTrophyParts(wasm, d, meshOpts, o, font).parts[1].positions;

  it('raised text sticks out of the front and engraved text does not', () => {
    const o: TrophyOptions = { ...base, plinth: 'straight', text };
    expect(bbox(plinthOnly(o)).min[1]).toBeCloseTo(-60 - 0.8, 1);
    expect(bbox(plinthOnly({ ...o, text: { ...text, style: 'engraved' } })).min[1]).toBeCloseTo(-60, 3);
  });

  it('text adds or removes material', () => {
    const vol = (o: TrophyOptions) => {
      const p = buildTrophyParts(wasm, d, meshOpts, o, font).parts[1];
      return expectSolid(p.positions, p.indices);
    };
    for (const shape of ['rectangle', 'circle', 'hexagon'] as const) {
      const o: TrophyOptions = { ...base, shape, plinth: 'tapered', text: null };
      // Expected volume without text, for the footprint used with text (round plinths get
      // a flat front): a frustum, h/3 · (A1 + A2 + √(A1·A2)).
      const cs = new wasm.CrossSection([footprint(shape, 120, 120, true).outline]);
      const [a1, k] = [cs.area(), 1 + base.taper];
      cs.delete();
      const plain = (base.plinthHeightMm / 3) * (a1 + a1 * k * k + a1 * k);
      expect(vol({ ...o, text }), `${shape} raised`).toBeGreaterThan(plain + 10);
      expect(vol({ ...o, text: { ...text, style: 'engraved' } }), `${shape} engraved`).toBeLessThan(plain - 10);
    }
  });

  it('plinth is a full prism or frustum, not a wedge', () => {
    const k = 1.12, P = 15;
    const straight = buildTrophyParts(wasm, d, meshOpts, { ...base, plinth: 'straight' }, font).parts[1];
    expect(expectSolid(straight.positions, straight.indices)).toBeCloseTo(120 * 120 * P, 0);
    const tapered = buildTrophyParts(wasm, d, meshOpts, { ...base, plinth: 'tapered' }, font).parts[1];
    // Frustum volume: h/3 · (A1 + A2 + √(A1·A2)).
    const [a1, a2] = [120 * 120, 120 * 120 * k * k];
    expect(expectSolid(tapered.positions, tapered.indices)).toBeCloseTo((P / 3) * (a1 + a2 + Math.sqrt(a1 * a2)), 0);
    const r = bbox(tapered.positions);
    expect(r.max[0] - r.min[0]).toBeCloseTo(120 * k, 1);
  });

  it('rebuilds a full-resolution trophy fast enough for live tweaks', () => {
    const big = dem(601);
    const o: TrophyOptions = { ...base, shape: 'circle', plinth: 'tapered', text };
    let t0 = performance.now();
    const r = buildTrophyParts(wasm, big, meshOpts, o, font);
    const build = performance.now() - t0;
    t0 = performance.now();
    const solid = unionParts(wasm, r.parts);
    const weld = performance.now() - t0;
    console.log(`601×601 circle + tapered plinth + text: build ${build.toFixed(0)} ms, export weld ${weld.toFixed(0)} ms, ${solid.indices.length / 3} triangles`);
    expect(build).toBeLessThan(1000);
  }, 60_000);
});
