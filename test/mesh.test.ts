import { describe, expect, it } from 'vitest';
import type { Dem } from '../src/core/dem';
import { cleanHeights } from '../src/core/dem';
import { buildTerrainMesh } from '../src/core/mesh';
import { stlByteLength, writeBinaryStl } from '../src/core/stl';

function fakeDem(cols: number, rows: number): Dem {
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) heights[r * cols + c] = 1000 + 300 * Math.sin(c / 3) * Math.cos(r / 4);
  let minM = Infinity, maxM = -Infinity;
  for (const h of heights) { minM = Math.min(minM, h); maxM = Math.max(maxM, h); }
  return { heights, cols, rows, groundWidthM: 5000, groundHeightM: 5000 * (rows - 1) / (cols - 1), minM, maxM };
}

describe('buildTerrainMesh', () => {
  const opts = { widthMm: 100, exaggeration: 2, baseMm: 5 };

  for (const [W, H] of [[2, 2], [7, 4], [40, 25]]) {
    it(`is a closed, consistently wound solid (${W}×${H})`, () => {
      const m = buildTerrainMesh(fakeDem(W, H), opts);
      // Closed + consistently oriented ⇔ every directed edge appears exactly once and
      // is matched by its reverse.
      const edges = new Map<string, number>();
      for (let t = 0; t < m.indices.length; t += 3) {
        for (let k = 0; k < 3; k++) {
          const key = `${m.indices[t + k]}>${m.indices[t + ((k + 1) % 3)]}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      }
      for (const [key, count] of edges) {
        expect(count, key).toBe(1);
        const [a, b] = key.split('>');
        expect(edges.has(`${b}>${a}`), `missing reverse of ${key}`).toBe(true);
      }
      // Outward normals give positive signed volume.
      let vol = 0;
      const p = m.positions;
      for (let t = 0; t < m.indices.length; t += 3) {
        const [a, b, c] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
        vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
          - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
          + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
      }
      expect(vol).toBeGreaterThan(0);
      expect(m.triangleCount).toBe(2 * (W - 1) * (H - 1) + 6 * (W + H - 2));
    });
  }

  it('scales to the requested width, base and exaggeration', () => {
    const dem = fakeDem(11, 11);
    const m = buildTerrainMesh(dem, opts);
    expect(m.sizeMm[0]).toBeCloseTo(100);
    expect(m.sizeMm[1]).toBeCloseTo(100);
    // 100 mm / 5000 m = 0.02 mm per m, ×2 exaggeration.
    expect(m.sizeMm[2]).toBeCloseTo(5 + (dem.maxM - dem.minM) * 0.04, 3);
  });

  it('writes a binary STL of the expected size', () => {
    const m = buildTerrainMesh(fakeDem(10, 10), opts);
    const stl = writeBinaryStl(m.positions, m.indices);
    expect(stl.byteLength).toBe(stlByteLength(m.triangleCount));
    expect(new DataView(stl).getUint32(80, true)).toBe(m.triangleCount);
  });
});

describe('cleanHeights', () => {
  it('fills gaps with the lowest valid height', () => {
    const h = cleanHeights(new Float32Array([NaN, 12, -3.4e38, 7]));
    expect(Array.from(h)).toEqual([7, 12, 7, 7]);
  });
});
