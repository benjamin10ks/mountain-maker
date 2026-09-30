import Module, { type ManifoldToplevel } from 'manifold-3d';
import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url';
import fontUrl from '@fontsource/oswald/files/oswald-latin-700-normal.woff?url';
import { parse, type Font } from 'opentype.js';
import { fetchDem, type Dem } from '../core/dem';
import { creasedGeometry } from '../core/normals';
import { writeBinaryStl } from '../core/stl';
import { buildTrophyParts, hasPlinth, mergeParts, unionParts, type MeshPart } from '../core/trophy';
import type { BuildRequest, PlaqueText, WorkerMessage, WorkerRequest } from './protocol';

// Download, decode, meshing and CSG all happen here so the map and preview never stall.
// The last DEM is cached: changing anything but the area or resolution skips the network.
let demCache: { key: string; dem: Dem } | null = null;
let lastParts: MeshPart[] | null = null;

// The CSG engine and font are only needed for plinths, so load them on first use.
let wasm: Promise<ManifoldToplevel> | null = null;
let font: Promise<Font> | null = null;
const loadWasm = () =>
  (wasm ??= Module({ locateFile: () => manifoldWasmUrl }).then((m) => {
    m.setup();
    return m;
  }));
const loadFont = () => (font ??= fetch(fontUrl).then((r) => r.arrayBuffer()).then((b) => parse(b)));

function send(msg: WorkerMessage, transfer: Transferable[] = []) {
  postMessage(msg, { transfer });
}

function plaqueLines(t: PlaqueText, maxM: number): string[] {
  const elevation = t.includeElevation ? `${Math.round(maxM * 3.28084).toLocaleString('en-US')} ft` : '';
  const lines = [t.name.trim(), [elevation, t.subtitle.trim()].filter(Boolean).join('  ·  ')];
  return t.allCaps ? lines.map((l) => l.toUpperCase()) : lines;
}

async function build(req: BuildRequest) {
  const { id, bounds, cols, rows } = req;
  const key = JSON.stringify([bounds, cols, rows]);
  let downloadMs = 0;
  if (demCache?.key !== key) {
    send({ id, type: 'progress', message: `Downloading ${cols}×${rows} elevation grid from USGS 3DEP…` });
    const t0 = performance.now();
    demCache = { key, dem: await fetchDem(bounds, cols, rows) };
    downloadMs = performance.now() - t0;
  }
  const { dem } = demCache;

  const trophy = {
    ...req.trophy,
    text: req.text ? { lines: plaqueLines(req.text, dem.maxM), style: req.text.style, side: req.text.side, depthMm: 0.8 } : null,
  };
  const plinth = hasPlinth(trophy);
  if (plinth) send({ id, type: 'progress', message: 'Building trophy…' });
  const [m, f] = plinth ? await Promise.all([loadWasm(), loadFont()]) : [null, null];
  const t0 = performance.now();

  const { parts, sizeMm, warnings } = buildTrophyParts(m, dem, req.mesh, trophy, f, req.minCapHeightMm);
  lastParts = parts;
  const merged = mergeParts(parts);
  const preview = creasedGeometry(merged.positions, merged.indices);
  send(
    {
      id,
      type: 'done',
      result: {
        preview,
        sizeMm,
        triangleCount: merged.indices.length / 3,
        dem: { minM: dem.minM, maxM: dem.maxM, groundWidthM: dem.groundWidthM, groundHeightM: dem.groundHeightM },
        warnings,
        buildMs: performance.now() - t0,
        downloadMs,
      },
    },
    [preview.positions.buffer, preview.normals.buffer],
  );
}

async function exportStl(id: number) {
  if (!lastParts) throw new Error('Generate a model first');
  if (lastParts.length > 1) send({ id, type: 'progress', message: 'Welding parts into one solid…' });
  const solid = unionParts(lastParts.length > 1 ? await loadWasm() : null, lastParts);
  const stl = writeBinaryStl(solid.positions, solid.indices);
  send({ id, type: 'stl', stl, triangleCount: solid.indices.length / 3 }, [stl]);
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.type === 'build') await build(req);
    else await exportStl(req.id);
  } catch (err) {
    send({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
