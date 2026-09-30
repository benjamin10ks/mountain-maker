import { describe, expect, it } from 'vitest';
import { MAX_TRIANGLES, recommend } from '../src/core/printers';

describe('recommend', () => {
  it('is limited by the nozzle for a typical mountain', () => {
    // 6 km area printed 120 mm wide with a 0.4 mm nozzle → one sample per 0.2 mm.
    const r = recommend({ groundWidthM: 6000, groundHeightM: 6000, widthMm: 120, nozzleMm: 0.4 });
    expect(r.limitedBy).toBe('printer');
    expect(r.cols).toBe(601);
    expect(r.rows).toBe(601);
    expect(r.spacingMm).toBeCloseTo(0.2);
  });

  it('never samples finer than the 1 m source for tiny areas', () => {
    const r = recommend({ groundWidthM: 200, groundHeightM: 100, widthMm: 150, nozzleMm: 0.2 });
    expect(r.limitedBy).toBe('data');
    expect(r.cols).toBe(201);
    expect(r.rows).toBe(101);
  });

  it('respects the triangle budget', () => {
    const r = recommend({ groundWidthM: 100_000, groundHeightM: 100_000, widthMm: 250, nozzleMm: 0.2 });
    expect(r.limitedBy).toBe('budget');
    expect(r.triangles).toBeLessThanOrEqual(MAX_TRIANGLES * 1.01);
  });

  it('warns when sampling finer than 10 m', () => {
    const r = recommend({ groundWidthM: 1500, groundHeightM: 1500, widthMm: 120, nozzleMm: 0.4 });
    expect(r.notes.some((n) => n.includes('lidar'))).toBe(true);
  });
});
