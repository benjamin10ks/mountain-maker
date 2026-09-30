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
3. **Terrain:** area width in mm, vertical exaggeration, and terrain base thickness.
4. **Trophy:** shape (rectangle, circle, hexagon), plinth (none, straight, tapered), and
   a nameplate on one side of the plinth (front, back, left or right; front is the
   map's south edge): name, optional subtitle (e.g. a summit date), the highest
   elevation in the area, raised or engraved.
5. **Resolution:** the recommended grid is shown with the reason for the limit. Tick
   **Custom** to override it.
6. **Generate model**, inspect the 3D preview, then **Download STL**. After the first
   build, changing settings rebuilds automatically; the elevation data is re-downloaded
   only when the area or resolution changes.

The sidebar, map and preview are separated by draggable dividers. Double-click a
divider (or focus it and press Home) to reset it; arrow keys nudge it. Sizes are
remembered per browser. Sidebar sections collapse by clicking their headings.

Other scripts:

| Command | What it does |
|---|---|
| `npm test` | Unit tests: every mesh, crop and trophy variant is a closed, outward-facing solid; text layout; STL format; recommendations |
| `npm run test:live` | End-to-end against the real USGS service; writes `rainier.stl` |
| `npm run typecheck` | TypeScript check |
| `npm run build` | Production build to `dist/` (a static site) |

## How it works

```
 Map (MapLibre + USGS Topo) ──bbox──►  Web Worker                          Main thread
 Search (Nominatim)                    1. fetch GeoTIFF from 3DEP (cached) three.js preview
 Printer, terrain, trophy  ──opts──►   2. crop terrain to the shape
                                       3. plinth + nameplate (manifold)
                                       4. creased normals ──preview──►
 Download ─────────────────export──►   5. weld parts, write STL ──stl──► file save
```

| File | Role |
|---|---|
| `src/core/geo.ts` | Web Mercator math, ground size of an area |
| `src/core/dem.ts` | Fetch and decode elevation from USGS 3DEP, fill gaps |
| `src/core/mesh.ts` | Height grid → closed solid (surface, walls, bottom) |
| `src/core/crop.ts` | Terrain solid cropped to a convex outline (circle, hexagon…) |
| `src/core/trophy.ts` | Footprint shapes, plinth, nameplate, export weld |
| `src/core/text.ts` | Font outlines → polygons, two-line plaque layout |
| `src/core/normals.ts` | Creased normals for the preview |
| `src/core/stl.ts` | Binary STL writer |
| `src/core/printers.ts` | Printer presets and the resolution recommendation |
| `src/worker/mesh.worker.ts` | Runs download, meshing, CSG and STL export off the UI thread |
| `src/ui/map.ts` | Basemap and rectangle selection |
| `src/ui/search.ts` | Place search |
| `src/ui/preview.ts` | 3D viewer |
| `src/ui/layout.ts` | Resizable panes |
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

Download, GeoTIFF decode, meshing, CSG and STL writing run in `mesh.worker.ts`, so the
map and preview never freeze. Buffers are **transferred** (zero-copy) back to the main
thread. The worker caches the last DEM by (area, grid), so model-only changes skip the
network.

**Only one build runs at a time.** Changes made while a build is running set a flag,
and exactly one follow-up build runs with the latest settings when it finishes. An
earlier version queued a build per change, so a burst of edits made the worker grind
through stale builds (7 s for three quick changes). The stats show the worker's build
time (about 0.2–0.9 s for a full-resolution trophy) and the download time when there
was one.

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

### 9. Trophy shapes

- **Rectangle, circle, hexagon.** Circle and hexagon are the largest of their kind that fit
  inside the selected area. The map shows the printed shape filled inside the dashed
  selection box.
- **The nameplate can go on any of four sides**: front, back, left or right, relative to
  the map (front = south). Many peaks' best face isn't the south one, so you can keep
  the good side of the mountain clear and put the text behind or beside it.
- Each shape is laid out once with the nameplate at the front, then rotated to the chosen
  side (`footprint()` swaps width and depth for left/right so it still fits the area).
  The text plate gets the same rotation, so every shape works on every side with one
  code path. Tests build all 12 shape × side combinations on a non-square area.
- **Hexagons turn so a flat side faces the nameplate.** For left/right that makes the
  points face north and south.
- **Round trophies with text get a flat edge on the nameplate side** (a "D" shape, chord
  at 80% of the radius). Flat text wrapped onto a curved face would be distorted or need
  curved extrusion. Without text, circles stay fully round.
- The preview camera turns to face the nameplate whenever the side changes.
- "Area width" still means the width of the selected area. For circles and hexagons the
  finished footprint is shown in the stats and checked against the bed.

### 10. Cropping the terrain without CSG

The first version cut the terrain with the CSG library (intersect with a cylinder). On a
601 × 601 grid that took about 2.6 s per rebuild: roughly 1.3 s to import a
720k-triangle mesh into manifold and 1.2 s for the intersection. That's too slow for live
tweaks.

Every footprint is **convex**, so `crop.ts` crops the grid directly:

- Grid triangles fully inside the outline are kept as-is (99% of them, handled at the
  speed of the plain rectangle mesh).
- Triangles on the edge are clipped against the outline (Sutherland–Hodgman), and only
  against the one or two outline edges that actually cross them.
- New vertices on the cut are **keyed by the two lines that create them** (a grid edge
  plus an outline edge, or two outline edges at a corner). Neighbouring triangles
  therefore share them exactly: no cracks and no T-junctions. Heights on the cut are
  interpolated along the grid edge, so they match the surface on both sides.
- The cut edges form one counter-clockwise loop. Walls and a fanned bottom are built
  from it exactly as for rectangles.
- The outline is shrunk by 0.01% and nudged off the grid, so no grid vertex ever lands
  exactly on it (inscribed shapes touch the area's border otherwise).

Result: about 0.2 s instead of 2.6 s, checked by tests on odd and non-square grids for
every shape.

### 11. Plinth and nameplate: manifold-3d, on small parts only

- **manifold-3d** (WASM) does the booleans. It guarantees manifold output, is the
  fastest robust CSG library available in JS, and is Apache-2.0.
- The plinth is an extrusion of the footprint. A **tapered** plinth is wider at the
  bottom (default 10%); its front face leans back, and the text is tilted to match.
- Text is **raised** (unioned) or **engraved** (subtracted), 0.8 mm deep, centered on the
  front face. Line 1 is the name; line 2 is 55% the size and holds the elevation and
  subtitle. The block is sized to fill 85% of the face width and 70% of its height. If
  letters come out smaller than about 7 nozzle widths (2.8 mm at 0.4 mm), you get a
  warning.
- **Only the plinth goes through CSG** (a few hundred triangles), so text changes take
  milliseconds.
- **Terrain and plinth are separate solids that overlap by 0.02 mm.** The preview shows
  them as-is. On **Download**, the worker welds them into one solid with a real union
  (a few seconds at full resolution, shown as "Welding parts into one solid…"). The
  exported STL is a single watertight solid; tests check both the parts and the welded
  result, and a downloaded Rainier hexagon checked in `trimesh` is one closed body
  (Euler number 2).
- **Pass `scaleTop` to `Manifold.extrude` as `[s, s]`, not a number.** manifold-3d 3.5
  treats a bare number as `[n, 0]` and silently collapses the top to a line, even though
  its types allow a number. This turned every plinth into a wedge until a volume test
  caught it. Tests now check plinth volumes against the prism and frustum formulas, and
  check that text really adds (raised) or removes (engraved) material.
- manifold objects live in WASM memory and are freed explicitly after each build.
- The WASM file (540 KB) and font are loaded only when a plinth is first used.

### 12. Text: opentype.js + Oswald

- **Oswald Bold** (SIL Open Font License, bundled from `@fontsource/oswald`): a condensed
  display face that reads well at small sizes and fits long peak names.
- **opentype.js** parses the WOFF file. We **don't use its shaper** (`font.getPath`):
  in v2.0 it throws on a GSUB lookup type Oswald uses, even with features turned off.
  `text.ts` places glyphs itself using advance widths and pair kerning, which is all
  plain Latin plaque text needs.
- Curves are flattened to 6 segments each. Glyph contours are combined with the NonZero
  fill rule, so counters (the holes in O, A, 8) come out correctly.
- "All caps" is on by default (plaque style). The elevation is the highest sample in the
  area, in feet. Bilinear resampling can read a few feet under the official summit
  height; type the official figure in the subtitle and untick the checkbox if it
  matters.

### 13. Preview normals

After cropping and CSG, surfaces share vertices across sharp edges, so plain smooth
normals smear the plinth corners and letters. `normals.ts` computes **creased
normals**: each corner averages only neighbouring faces within 40° of its own face.
Terrain stays smooth, and edges and text stay crisp. It runs in the worker and ships
non-indexed buffers straight to three.js.

### 14. Resizable panes

- **Why:** the map matters while choosing an area, and the preview while tuning the
  trophy. The sidebar grows with long nameplate text.
- CSS grid with the sizes in CSS variables (`--sidebar-w`, `--map-fr`/`--preview-fr`),
  changed by two splitters (`layout.ts`). Pointer capture keeps a drag going over the
  map and 3D canvases.
- Sizes persist in `localStorage` (a per-browser convenience; failures are ignored).
- Splitters are focusable `role="separator"` elements: arrow keys nudge, and Home or
  double-click resets.
- MapLibre is told to resize on every change; the preview follows via ResizeObserver.
- On narrow screens (< 800 px) the panes stack and the splitters are hidden.

## Known limitations

- One nameplate per trophy, in one font.
- Areas are measured with a single `cos(latitude)` scale. Very tall selections (hundreds
  of km north–south) will be slightly distorted.
- The first production chunk is about 1.6 MB (MapLibre + three.js). This could be
  code-split later.
- There is no check that the area is inside the US. Areas outside 3DEP coverage fail with
  "No elevation data", or come back flat where the service returns 0.

## Roadmap

1. ~~**Core engine:** bbox → 3DEP → watertight STL~~ ✅
2. ~~**Web UI:** map, search, drag-select, printer presets, recommendations, preview~~ ✅ (first version)
3. ~~**Trophy:** round/hex crops, straight/tapered plinths, raised/engraved nameplate~~ ✅
   Nameplate side (front/back/left/right) ✅. Next: stepped plinth, font choice, a
   second nameplate, touch drawing, a mark at the summit
4. **Multi-color:** 3MF export with separate bodies (snowcap above an elevation, water,
   base) for the Bambu AMS
5. **Hosting:** static deploy, production geocoder, code-splitting
