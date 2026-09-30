import './style.css';
import { groundSizeMeters, type LngLatBounds } from './core/geo';
import type { TerrainMesh } from './core/mesh';
import { describeGrid, NOZZLES_MM, PRINTERS, recommend, type Recommendation } from './core/printers';
import { writeBinaryStl } from './core/stl';
import { createAreaMap } from './ui/map';
import { createPreview } from './ui/preview';
import { searchPlaces } from './ui/search';
import type { BuildRequest, DemSummary, WorkerMessage } from './worker/protocol';

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;

const ui = {
  searchForm: $<HTMLFormElement>('search-form'),
  searchInput: $('search-input'),
  searchResults: $<HTMLUListElement>('search-results'),
  drawBtn: $<HTMLButtonElement>('draw-btn'),
  areaInfo: $<HTMLParagraphElement>('area-info'),
  printer: $<HTMLSelectElement>('printer'),
  bedX: $('bed-x'),
  bedY: $('bed-y'),
  bedZ: $('bed-z'),
  nozzle: $<HTMLSelectElement>('nozzle'),
  layer: $('layer'),
  width: $('width'),
  exag: $('exag'),
  exagOut: $<HTMLOutputElement>('exag-out'),
  base: $('base'),
  rec: $<HTMLDivElement>('rec'),
  customRes: $('custom-res'),
  cols: $('cols'),
  generate: $<HTMLButtonElement>('generate'),
  download: $<HTMLButtonElement>('download'),
  status: $<HTMLParagraphElement>('status'),
  stats: $<HTMLDivElement>('stats'),
};

let bounds: LngLatBounds | null = null;
let grid: Recommendation | null = null;
let lastMesh: TerrainMesh | null = null;

// ---- Printer setup ---------------------------------------------------------

for (const p of PRINTERS) ui.printer.add(new Option(p.name, p.id));
for (const n of NOZZLES_MM) ui.nozzle.add(new Option(`${n}`, `${n}`, n === 0.4, n === 0.4));
ui.printer.value = 'bambu-p1s';

function applyPrinter() {
  const p = PRINTERS.find((x) => x.id === ui.printer.value)!;
  [ui.bedX.value, ui.bedY.value, ui.bedZ.value] = p.bed.map(String);
  const custom = p.id === 'custom';
  for (const el of [ui.bedX, ui.bedY, ui.bedZ]) el.readOnly = !custom;
}
ui.printer.addEventListener('change', () => {
  applyPrinter();
  update();
});
applyPrinter();

const num = (el: HTMLInputElement | HTMLSelectElement) => Number(el.value);

// ---- Map and search -------------------------------------------------------

const areaMap = createAreaMap($('map'), (b) => setArea(b));

function setArea(b: LngLatBounds, fit = false) {
  bounds = b;
  areaMap.setSelection(b, fit);
  const { widthM, heightM } = groundSizeMeters(b);
  const mi = (m: number) => (m / 1609.344).toFixed(2);
  ui.areaInfo.textContent = `${(widthM / 1000).toFixed(2)} × ${(heightM / 1000).toFixed(2)} km (${mi(widthM)} × ${mi(heightM)} mi)`;
  update();
}

ui.drawBtn.addEventListener('click', () => {
  areaMap.startDrawing();
  ui.areaInfo.textContent = 'Click and drag on the map to select an area.';
});

ui.searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = ui.searchInput.value.trim();
  if (!q) return;
  ui.searchResults.innerHTML = '<li class="muted">Searching…</li>';
  try {
    const places = await searchPlaces(q);
    ui.searchResults.innerHTML = '';
    if (!places.length) ui.searchResults.innerHTML = '<li class="muted">No US results.</li>';
    for (const p of places) {
      const li = document.createElement('li');
      li.textContent = p.name;
      li.title = p.name;
      li.addEventListener('click', () => {
        ui.searchResults.innerHTML = '';
        setArea(p.bounds, true);
      });
      ui.searchResults.appendChild(li);
    }
  } catch (err) {
    ui.searchResults.innerHTML = `<li class="error">${(err as Error).message}</li>`;
  }
});

// ---- Recommendation ---------------------------------------------------------

function update() {
  ui.exagOut.textContent = `${num(ui.exag).toFixed(1)}×`;
  ui.cols.disabled = !ui.customRes.checked;
  if (!bounds) return;

  const { widthM, heightM } = groundSizeMeters(bounds);
  const input = { groundWidthM: widthM, groundHeightM: heightM, widthMm: num(ui.width), nozzleMm: num(ui.nozzle) };
  const rec = recommend(input);
  grid = ui.customRes.checked && num(ui.cols) >= 2 ? describeGrid(input, Math.round(num(ui.cols))) : rec;
  if (!ui.customRes.checked) ui.cols.value = String(rec.cols);

  const why = {
    printer: `finest detail a ${input.nozzleMm} mm nozzle can print`,
    data: 'best 3DEP source resolution (1 m)',
    budget: 'mesh size budget',
    service: '3DEP request size limit',
  }[rec.limitedBy];
  ui.rec.classList.remove('muted');
  ui.rec.innerHTML =
    `Recommended: <strong>${rec.cols} × ${rec.rows}</strong> samples<br>` +
    `<span class="muted">Limited by ${why}.</span><br>` +
    `Using ${grid.cols} × ${grid.rows}: one sample every ${grid.groundSpacingM.toFixed(1)} m ` +
    `(${grid.spacingMm.toFixed(2)} mm on the model)<br>` +
    `${(grid.triangles / 1e6).toFixed(2)} M triangles · ${(grid.stlBytes / 1e6).toFixed(0)} MB STL` +
    grid.notes.map((n) => `<div class="note">${n}</div>`).join('');

  const depthMm = (input.widthMm * heightM) / widthM;
  const fits = input.widthMm <= num(ui.bedX) && depthMm <= num(ui.bedY);
  ui.generate.disabled = !fits;
  ui.status.textContent = fits ? '' : `Model is ${input.widthMm} × ${depthMm.toFixed(0)} mm: too big for the bed.`;
  ui.status.className = fits ? 'muted' : 'error';

  if (lastMesh) scheduleRebuild();
}

for (const el of [ui.bedX, ui.bedY, ui.bedZ, ui.nozzle, ui.layer, ui.width, ui.exag, ui.base, ui.customRes, ui.cols]) {
  el.addEventListener('input', update);
}

// ---- Build -------------------------------------------------------------------

const worker = new Worker(new URL('./worker/mesh.worker.ts', import.meta.url), { type: 'module' });
const preview = createPreview($('preview'));
let buildId = 0;

function build() {
  if (!bounds || !grid || ui.generate.disabled) return;
  const req: BuildRequest = {
    id: ++buildId,
    bounds,
    cols: grid.cols,
    rows: grid.rows,
    mesh: { widthMm: num(ui.width), exaggeration: num(ui.exag), baseMm: num(ui.base) },
  };
  ui.generate.disabled = true;
  worker.postMessage(req);
}

// After the first model, tweaking settings re-meshes automatically. The worker caches
// the DEM, so this only re-downloads when the area or resolution changes.
let rebuildTimer: number | undefined;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(build, 300);
}

worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  if (msg.id !== buildId) return; // a newer build superseded this one
  if (msg.type === 'progress') {
    ui.status.className = 'muted';
    ui.status.textContent = msg.message;
    return;
  }
  ui.generate.disabled = false;
  if (msg.type === 'error') {
    ui.status.className = 'error';
    ui.status.textContent = msg.message;
    return;
  }
  lastMesh = msg.mesh;
  $('preview').querySelector('.placeholder')?.remove();
  preview.show(msg.mesh);
  ui.download.disabled = false;
  ui.status.textContent = '';
  showStats(msg.mesh, msg.dem);
};

function showStats(mesh: TerrainMesh, dem: DemSummary) {
  const [x, y, z] = mesh.sizeMm;
  const zScale = (num(ui.width) / dem.groundWidthM) * num(ui.exag);
  const metersPerLayer = num(ui.layer) / zScale;
  const tooTall = z > num(ui.bedZ);
  ui.stats.innerHTML = `<dl>
    <dt>Model</dt><dd>${x.toFixed(0)} × ${y.toFixed(0)} × ${z.toFixed(1)} mm</dd>
    <dt>Elevation</dt><dd>${dem.minM.toFixed(0)}–${dem.maxM.toFixed(0)} m (${(dem.minM * 3.281).toFixed(0)}–${(dem.maxM * 3.281).toFixed(0)} ft)</dd>
    <dt>Triangles</dt><dd>${mesh.triangleCount.toLocaleString()}</dd>
    <dt>Per layer</dt><dd>each ${num(ui.layer)} mm layer ≈ ${metersPerLayer.toFixed(1)} m of elevation</dd>
  </dl>${tooTall ? '<div class="note">Taller than the printer\'s build height.</div>' : ''}`;
}

ui.generate.addEventListener('click', build);

ui.download.addEventListener('click', () => {
  if (!lastMesh) return;
  const stl = writeBinaryStl(lastMesh.positions, lastMesh.indices);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([stl], { type: 'model/stl' }));
  const name = ui.searchInput.value.trim().replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'terrain';
  a.download = `${name}.stl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

update();
