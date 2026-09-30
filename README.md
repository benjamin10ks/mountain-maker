# Mountain Maker

Turn any area of the United States into a 3D-printable terrain model. Search for a peak or
drag a box on the map, pick your printer, and download a watertight STL ready for Bambu
Studio (or any slicer). The end goal is mountain "trophies": desk statues of peaks you've
climbed.

Everything runs in the browser. There is no backend.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

1. **Area:** search a place (e.g. "Mount Rainier") and pick a result, or click
   **Draw area on map** and click-drag a rectangle.
2. **Printer:** choose a preset (Bambu A1 mini / A1 / P1S / X1C / H2D, Prusa MK4) or
   **Custom**, then set nozzle and layer height.
3. **Model:** width in mm, vertical exaggeration, and base thickness.
4. **Resolution:** the recommended grid is shown with the reason for the limit. Tick
   **Custom** to override it.
5. **Generate model**, inspect the 3D preview, then **Download STL**. After the first
   build, changing settings re-meshes automatically; the elevation data is re-downloaded
   only when the area or resolution changes.

Other scripts:

| Command | What it does |
|---|---|
| `npm test` | Unit tests: mesh is closed and outward-facing, STL format, recommendations |
| `npm run test:live` | End-to-end against the real USGS service; writes `rainier.stl` |
| `npm run typecheck` | TypeScript check |
| `npm run build` | Production build to `dist/` (a static site) |

## How it works

```
 Map (MapLibre + USGS Topo) ──bbox──►  Web Worker                       Main thread
 Search (Nominatim)                    1. fetch GeoTIFF from 3DEP        three.js preview
 Printer + model settings ──grid──►    2. clean no-data                  STL download
                                       3. build watertight mesh ──mesh──►
```

| File | Role |
|---|---|
| `src/core/geo.ts` | Web Mercator math, ground size of an area |
| `src/core/dem.ts` | Fetch and decode elevation from USGS 3DEP, fill gaps |
| `src/core/mesh.ts` | Height grid → closed solid (surface, walls, bottom) |
| `src/core/stl.ts` | Binary STL writer |
| `src/core/printers.ts` | Printer presets and the resolution recommendation |
| `src/worker/mesh.worker.ts` | Runs download + meshing off the UI thread, caches the last DEM |
| `src/ui/map.ts` | Basemap and rectangle selection |
| `src/ui/search.ts` | Place search |
| `src/ui/preview.ts` | 3D viewer |
| `src/main.ts` | Wires the UI together |

`src/core/` has no DOM dependencies, so it can be reused for a CLI or server later
(`test/live.test.ts` already runs it under Node).

## Decisions

### 1. TypeScript in the browser, not Python

Python (NumPy, rasterio, trimesh) was the obvious alternative. We chose browser-only
TypeScript because:

- **Performance is not decided by the language.** Downloading the elevation data takes
  0.5–5 s. Building a 700k-triangle mesh in plain TypeScript takes tens of milliseconds.
  Rust, Go or NumPy would save milliseconds on a step that is already fast.
- **Hosting is free if there is no server.** The 3DEP service sends
  `Access-Control-Allow-Origin: *` (verified), so the browser can fetch elevation
  directly. The whole app is a static site (GitHub Pages, Cloudflare Pages, Netlify) that
  scales to any number of users at no cost. A Python version would need a server doing
  mesh work for every user.
- **Fast feedback.** The DEM stays in memory, so changing exaggeration or base thickness
  re-meshes and re-renders in well under a second.
- **One language** for the whole project.

Trade-off: Python's geospatial ecosystem is richer. With a single fixed data source
(3DEP) and only Web Mercator math needed, we don't need most of it.

### 2. Data source: USGS 3DEP dynamic elevation service

- Scope is the US only, and 3DEP is the best free US elevation data: 10 m (1/3
  arc-second) nationwide and 1 m lidar across much of the country.
- We call the ArcGIS ImageServer `exportImage` endpoint. It resamples the best available
  source to exactly the grid we request, as a Float32 GeoTIFF. There are no tiles to
  stitch, no API key, and no bulk downloads.
- Requests are in **EPSG:3857 (Web Mercator)**, the service's native projection and also
  the map's. Mercator pixels are square, and scaling by `cos(latitude)` converts them to
  ground meters (accurate to well under 1% at mountain scale).
- **The request grid must match the bbox aspect ratio.** If it doesn't, the service
  silently expands the extent to fit, and the model covers the wrong area (found while
  testing). `fetchDem` also checks the returned size.
- Limit: 8000 × 8000 samples per request.
- No-data: open ocean comes back as `0`; other gaps may be NaN or float-min sentinels.
  Invalid samples are filled with the lowest valid height.
- Interpolation: bilinear. Rainier's 4392 m summit comes back about right at 10 m
  spacing.

### 3. Resolution recommendation

The grid should be as detailed as the printer can reproduce, and no more. The
recommended column count is the smallest of:

| Limit | Rule | Why |
|---|---|---|
| **Printer** | one sample per `nozzle / 2` mm on the model | A nozzle can't render features much smaller than half its width; finer sampling only makes files bigger |
| **Data** | one sample per 1 m on the ground | 3DEP's best source resolution; anything finer is invented |
| **Budget** | ≤ 4 M triangles (~200 MB STL) | Keeps generation, preview and slicing comfortable |
| **Service** | ≤ 8000 samples per side | 3DEP request limit |

Rows follow from the area's aspect ratio. The UI says which limit applies, and warns
when:

- sampling is finer than 10 m (real detail only where lidar exists),
- a custom grid is finer than the nozzle can print,
- the model doesn't fit the bed (Generate is disabled) or is taller than the build height.

It also shows **meters of elevation per layer** (e.g. "each 0.2 mm layer ≈ 3.3 m"), which
helps choose exaggeration.

Example: a 6 km area printed 120 mm wide with a 0.4 mm nozzle → 601 × 601 samples, one
every 10 m (0.2 mm on the model), 0.73 M triangles, 36 MB STL. Printer and data line up
well at this scale, which is typical for a single peak.

### 4. Mesh construction

- Units are **mm**, **+x east, +y north, +z up**. DEM row 0 is north.
- Terrain height = `base + (h − h_min) × mm_per_meter × exaggeration`, so the lowest point
  sits exactly `base` mm above the bed.
- The solid is **watertight and manifold**: a grid surface (2 triangles per cell), four
  walls joining the edge vertices to a z=0 copy, and a bottom fanned from a center
  vertex. The bottom shares the walls' vertices exactly, so there are no T-junctions.
- All triangles are **counter-clockwise seen from outside** (outward normals).
- Tests check that every directed edge appears exactly once and is matched by its reverse
  (closed + consistently wound) and that signed volume is positive. The live Rainier STL
  was also checked independently with Python `trimesh`: `is_watertight`,
  `is_winding_consistent`, positive volume.
- Output is **binary STL** (50 bytes/triangle). ASCII STL would be roughly 5× larger.
- Not yet done: simplifying flat areas (adaptive triangulation). At the recommended
  resolutions, files are fine for Bambu Studio without it.

### 5. Web Worker

Download, GeoTIFF decode and meshing run in `mesh.worker.ts`, so the map and preview never
freeze. Mesh buffers are **transferred** (zero-copy) back to the main thread. The worker
caches the last DEM by (area, grid), so model-only changes skip the network. Builds carry
an id, and the UI ignores results from builds that a newer one replaced.

### 6. UI stack: vanilla TypeScript + Vite

- **No framework (React etc.) for now.** The UI is one form plus two canvases. A framework
  can be added if the UI grows (saved designs, trophy editor).
- **Vite** for dev server and build. `worker.format = 'es'` because both workers are ES
  modules.
- **MapLibre GL** for the map: open source, WebGL, and no token needed.
  - MapLibre v6 finds its worker as a file next to its own module, which breaks once Vite
    bundles it ("Worker failed to load"). We import the worker with
    `?worker&url` and call `setWorkerUrl()` (see `src/ui/map.ts`).
- **Basemap: USGS Topo tiles** (The National Map). Free, no key, shows contours and peak
  names, and matches the data source. They can be slow to load on first view.
- **Rectangle selection** is about 40 lines on MapLibre mouse events. We didn't need a
  drawing library for one shape. Touch drawing isn't supported yet.
- **three.js** preview shows the exact buffers that will be exported. The terrain uses
  smooth normals and the walls/bottom flat normals, so edges stay crisp. The camera
  reframes when the model changes size by more than 10% and otherwise keeps your orbit.

### 7. Search: OpenStreetMap Nominatim

- US-only (`countrycodes=us`), free, no key, and finds peaks, parks and towns.
- Point results (most peaks) get a 6 km box around them; results with a useful bounding
  box (parks, ranges) use it.
- Nominatim's usage policy allows light use and forbids autocomplete, so search runs only
  on submit. **Before hosting publicly**, switch to a provider meant for app traffic
  (e.g. a hosted Nominatim/Photon, or the USGS GNIS names service for peaks).

### 8. Printer presets

Build volumes (mm): A1 mini 180³; A1, P1S/P1P, X1C/X1E 256³; H2D 350×320×325;
Prusa MK4/MK4S 250×210×220. **Custom** unlocks the bed fields. Presets live in
`src/core/printers.ts`; add yours there.

## Known limitations

- Rectangles only. Circle/hexagon crops come in Phase 3.
- Areas are measured with a single `cos(latitude)` scale. Very tall selections (hundreds
  of km north–south) will be slightly distorted.
- The first production chunk is about 1.6 MB (MapLibre + three.js). This could be
  code-split later.
- There is no check that the area is inside the US. Areas outside 3DEP coverage fail with
  "No elevation data", or come back flat where the service returns 0.

## Roadmap

1. ~~**Core engine:** bbox → 3DEP → watertight STL~~ ✅
2. ~~**Web UI:** map, search, drag-select, printer presets, recommendations, preview~~ ✅ (first version)
3. **Trophy polish:** round/hex crops, plinth styles (tapered, stepped), raised or
   engraved text (peak name, elevation, date) via `manifold-3d` (WASM), touch drawing
4. **Multi-color:** 3MF export with separate bodies (snowcap above an elevation, water,
   base) for the Bambu AMS
5. **Hosting:** static deploy, production geocoder, code-splitting
