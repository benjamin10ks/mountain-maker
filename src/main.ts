import './style.css';
import { fractionsToLngLat, groundSizeMeters, type LngLatBounds } from './core/geo';
import { describeGrid, NOZZLES_MM, PRINTERS, recommend, type Recommendation } from './core/printers';
import { hasPlinth, plinthScale, trophyFootprint, type PlinthStyle, type Shape, type TrophyOptions } from './core/trophy';
import { initLayout } from './ui/layout';
import { createAreaMap } from './ui/map';
import { createPreview } from './ui/preview';
import { searchPlaces } from './ui/search';
import type { BuildRequest, BuildResult, PlaqueText, WorkerMessage } from './worker/protocol';

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
  plinth: $<HTMLSelectElement>('plinth'),
  plinthH: $('plinth-h'),
  taper: $('taper'),
  taperWrap: $<HTMLLabelElement>('taper-wrap'),
  plaque: $<HTMLFieldSetElement>('plaque'),
  plaqueNote: $<HTMLParagraphElement>('plaque-note'),
  textName: $('text-name'),
  textSub: $('text-sub'),
  textElev: $('text-elev'),
  textCaps: $('text-caps'),
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
let built = false;
/** True while the name field still holds the name we filled in from search. */
let autoName = true;

const num = (el: HTMLInputElement | HTMLSelectElement) => Number(el.value);
const radio = (name: string) => (document.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement).value;

// ---- Layout -------------------------------------------------------------------

const areaMap = createAreaMap($('map'), (b) => setArea(b));
initLayout($('app'), document.querySelector('main')!, () => areaMap.map.resize());

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

// ---- Map and search -------------------------------------------------------

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
        if (autoName) ui.textName.value = p.name.split(',')[0];
        setArea(p.bounds, true);
      });
      ui.searchResults.appendChild(li);
    }
  } catch (err) {
    ui.searchResults.innerHTML = `<li class="error">${(err as Error).message}</li>`;
  }
});

ui.textName.addEventListener('input', () => (autoName = ui.textName.value === ''));

// ---- Settings → trophy options ---------------------------------------------

function trophyOptions(): Omit<TrophyOptions, 'text'> {
  return {
    shape: radio('shape') as Shape,
    plinth: ui.plinth.value as PlinthStyle,
    plinthHeightMm: num(ui.plinthH),
    taper: num(ui.taper) / 100,
  };
}

function plaqueText(): PlaqueText | null {
  const t: PlaqueText = {
    name: ui.textName.value,
    subtitle: ui.textSub.value,
    includeElevation: ui.textElev.checked,
    allCaps: ui.textCaps.checked,
    style: radio('text-style') as PlaqueText['style'],
  };
  return t.name.trim() || t.subtitle.trim() || t.includeElevation ? t : null;
}

/** The trophy options with placeholder text, for layout decisions made before a build. */
function trophyForLayout(): TrophyOptions {
  const t = plaqueText();
  return { ...trophyOptions(), text: t ? { lines: ['x'], style: t.style, depthMm: 0.8 } : null };
}

// ---- Recommendation and fit ---------------------------------------------------

function update() {
  ui.exagOut.textContent = `${num(ui.exag).toFixed(1)}×`;
  ui.cols.disabled = !ui.customRes.checked;
  const trophy = trophyForLayout();
  ui.taperWrap.hidden = trophy.plinth !== 'tapered';
  ui.plinthH.disabled = trophy.plinth === 'none';
  ui.plaque.disabled = !hasPlinth(trophy);
  ui.plaqueNote.textContent = hasPlinth(trophy)
    ? trophy.shape === 'circle' && trophy.text
      ? 'Round trophies get a flat front for the nameplate.'
      : ''
    : 'Add a plinth to put a nameplate on the front.';
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

  // Show the printed shape on the map, and check the finished footprint fits the bed.
  const depthMm = (input.widthMm * heightM) / widthM;
  const fp = trophyFootprint(trophy, input.widthMm, depthMm);
  const uv = fp.outline.map(([x, y]): [number, number] => [x / input.widthMm + 0.5, y / depthMm + 0.5]);
  areaMap.setCrop(fractionsToLngLat(bounds, uv));
  const k = hasPlinth(trophy) ? plinthScale(trophy) : 1;
  const [fw, fd] = [fp.width * k, fp.depth * k];
  const fits = fw <= num(ui.bedX) && fd <= num(ui.bedY);
  ui.generate.disabled = !fits;
  ui.status.textContent = fits ? '' : `Trophy is ${fw.toFixed(0)} × ${fd.toFixed(0)} mm: too big for the bed.`;
  ui.status.className = fits ? 'muted' : 'error';

  if (built && fits) scheduleRebuild();
}

document.querySelectorAll('#sidebar input, #sidebar select').forEach((el) => {
  if (el.id === 'search-input') return;
  el.addEventListener('input', update);
});

// ---- Build and export ---------------------------------------------------------

const worker = new Worker(new URL('./worker/mesh.worker.ts', import.meta.url), { type: 'module' });
const preview = createPreview($('preview'));
let requestId = 0;
let buildId = 0;
let exportId = 0;

// One build at a time: changes made while the worker is busy are coalesced into a single
// follow-up build, so dragging a slider never queues a backlog of stale builds.
let building = false;
let buildAgain = false;

function build() {
  if (!bounds || !grid || ui.generate.disabled) return;
  if (building) {
    buildAgain = true;
    return;
  }
  building = true;
  const req: BuildRequest = {
    type: 'build',
    id: (buildId = ++requestId),
    bounds,
    cols: grid.cols,
    rows: grid.rows,
    mesh: { widthMm: num(ui.width), exaggeration: num(ui.exag), baseMm: num(ui.base) },
    trophy: trophyOptions(),
    text: plaqueText(),
    // Letters much smaller than ~7 nozzle widths lose their shape.
    minCapHeightMm: Math.max(2.5, num(ui.nozzle) * 7),
  };
  ui.download.disabled = true;
  worker.postMessage(req);
}

function buildFinished() {
  building = false;
  if (buildAgain) {
    buildAgain = false;
    build();
  }
}

// After the first model, tweaking settings rebuilds automatically. The worker caches
// the DEM, so this only re-downloads when the area or resolution changes.
let rebuildTimer: number | undefined;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(build, 300);
}

worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  if (msg.id !== buildId && msg.id !== exportId) return; // superseded
  if (msg.type === 'progress') {
    ui.status.className = 'muted';
    ui.status.textContent = msg.message;
    return;
  }
  if (msg.type === 'error') {
    if (msg.id === buildId) buildFinished();
    ui.download.disabled = !built;
    ui.status.className = 'error';
    ui.status.textContent = msg.message;
    return;
  }
  if (msg.type === 'stl') {
    ui.download.disabled = false;
    ui.status.textContent = '';
    saveStl(msg.stl);
    return;
  }
  ui.download.disabled = false;
  ui.status.textContent = '';
  built = true;
  buildFinished();
  $('preview').querySelector('.placeholder')?.remove();
  preview.show(msg.result.preview.positions, msg.result.preview.normals, msg.result.sizeMm);
  showStats(msg.result);
};

function showStats(r: BuildResult) {
  const [x, y, z] = r.sizeMm;
  const zScale = (num(ui.width) / r.dem.groundWidthM) * num(ui.exag);
  const metersPerLayer = num(ui.layer) / zScale;
  const notes = [...r.warnings];
  if (z > num(ui.bedZ)) notes.push("Taller than the printer's build height.");
  ui.stats.innerHTML = `<dl>
    <dt>Trophy</dt><dd>${x.toFixed(0)} × ${y.toFixed(0)} × ${z.toFixed(1)} mm</dd>
    <dt>Elevation</dt><dd>${r.dem.minM.toFixed(0)}–${r.dem.maxM.toFixed(0)} m (${(r.dem.minM * 3.281).toFixed(0)}–${(r.dem.maxM * 3.281).toFixed(0)} ft)</dd>
    <dt>Triangles</dt><dd>${r.triangleCount.toLocaleString()}</dd>
    <dt>Built in</dt><dd>${r.buildMs.toFixed(0)} ms${r.downloadMs ? ` + ${(r.downloadMs / 1000).toFixed(1)} s download` : ''}</dd>
    <dt>Per layer</dt><dd>each ${num(ui.layer)} mm layer ≈ ${metersPerLayer.toFixed(1)} m of elevation</dd>
  </dl>${notes.map((n) => `<div class="note">${n}</div>`).join('')}`;
}

function saveStl(stl: ArrayBuffer) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([stl], { type: 'model/stl' }));
  const name = (ui.textName.value || ui.searchInput.value).trim().replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'terrain';
  a.download = `${name}.stl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

ui.generate.addEventListener('click', build);
ui.download.addEventListener('click', () => {
  ui.download.disabled = true;
  worker.postMessage({ type: 'export', id: (exportId = ++requestId) });
});

update();
