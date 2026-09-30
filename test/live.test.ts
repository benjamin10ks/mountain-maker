import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchDem } from '../src/core/dem';
import { boxAround, groundSizeMeters } from '../src/core/geo';
import { buildTerrainMesh } from '../src/core/mesh';
import { recommend } from '../src/core/printers';
import { writeBinaryStl } from '../src/core/stl';

// Hits the real USGS service. Run with `npm run test:live`.
describe.runIf(process.env.LIVE)('live 3DEP', () => {
  it('builds Mount Rainier end to end', async () => {
    const bounds = boxAround(-121.7603, 46.8529, 8000);
    const { widthM, heightM } = groundSizeMeters(bounds);
    const rec = recommend({ groundWidthM: widthM, groundHeightM: heightM, widthMm: 120, nozzleMm: 0.4 });
    const dem = await fetchDem(bounds, rec.cols, rec.rows);
    // Summit is 4392 m; bilinear resampling shaves a little off.
    expect(dem.maxM).toBeGreaterThan(4300);
    expect(dem.maxM).toBeLessThan(4400);
    const mesh = buildTerrainMesh(dem, { widthMm: 120, exaggeration: 1.5, baseMm: 5 });
    const out = process.env.LIVE_OUT ?? 'rainier.stl';
    writeFileSync(out, new Uint8Array(writeBinaryStl(mesh.positions, mesh.indices)));
    console.log(`${rec.cols}×${rec.rows}, ${dem.minM.toFixed(0)}–${dem.maxM.toFixed(0)} m, ` +
      `${mesh.sizeMm.map((v) => v.toFixed(1)).join(' × ')} mm, ${mesh.triangleCount} triangles → ${out}`);
  }, 60_000);
});
