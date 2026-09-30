import { fetchDem, type Dem } from '../core/dem';
import { buildTerrainMesh } from '../core/mesh';
import type { BuildRequest, WorkerMessage } from './protocol';

// Download, decode and meshing all happen here so the map and preview never stall.
// The last DEM is cached: changing exaggeration or base thickness only re-meshes.
let cache: { key: string; dem: Dem } | null = null;

function send(msg: WorkerMessage, transfer: Transferable[] = []) {
  postMessage(msg, { transfer });
}

self.onmessage = async (e: MessageEvent<BuildRequest>) => {
  const { id, bounds, cols, rows, mesh } = e.data;
  try {
    const key = JSON.stringify([bounds, cols, rows]);
    if (cache?.key !== key) {
      send({ id, type: 'progress', message: `Downloading ${cols}×${rows} elevation grid from USGS 3DEP…` });
      cache = { key, dem: await fetchDem(bounds, cols, rows) };
    }
    const { dem } = cache;
    send({ id, type: 'progress', message: 'Building mesh…' });
    const m = buildTerrainMesh(dem, mesh);
    send(
      {
        id,
        type: 'done',
        mesh: m,
        dem: { minM: dem.minM, maxM: dem.maxM, groundWidthM: dem.groundWidthM, groundHeightM: dem.groundHeightM },
      },
      [m.positions.buffer, m.indices.buffer],
    );
  } catch (err) {
    send({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
