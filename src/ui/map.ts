import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { LngLatBounds } from '../core/geo';

// MapLibre v6 looks for its worker next to its own module file, which breaks once Vite
// bundles it. Let Vite build the worker as its own entry and point MapLibre at it.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

const USGS_TOPO =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';

export interface AreaMap {
  map: maplibregl.Map;
  setSelection(b: LngLatBounds | null, fit?: boolean): void;
  startDrawing(): void;
}

/** Map with a USGS topo basemap and click-drag rectangle selection. */
export function createAreaMap(container: HTMLElement, onSelect: (b: LngLatBounds) => void): AreaMap {
  const map = new maplibregl.Map({
    container,
    center: [-98.5, 39.8],
    zoom: 3.5,
    style: {
      version: 8,
      sources: {
        topo: {
          type: 'raster',
          tiles: [USGS_TOPO],
          tileSize: 256,
          maxzoom: 16,
          attribution: 'Basemap: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS The National Map</a>',
        },
      },
      layers: [{ id: 'topo', type: 'raster', source: 'topo' }],
    },
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

  let pending: LngLatBounds | null = null;
  const empty = { type: 'FeatureCollection' as const, features: [] };
  const toGeoJson = (b: LngLatBounds | null) =>
    b
      ? {
          type: 'Feature' as const,
          properties: {},
          geometry: {
            type: 'Polygon' as const,
            coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]],
          },
        }
      : empty;

  const render = (b: LngLatBounds | null) => {
    const src = map.getSource<GeoJSONSource>('selection');
    if (src) src.setData(toGeoJson(b));
    else pending = b;
  };

  map.on('load', () => {
    map.addSource('selection', { type: 'geojson', data: toGeoJson(pending) });
    map.addLayer({ id: 'selection-fill', type: 'fill', source: 'selection', paint: { 'fill-color': '#e4572e', 'fill-opacity': 0.15 } });
    map.addLayer({ id: 'selection-line', type: 'line', source: 'selection', paint: { 'line-color': '#e4572e', 'line-width': 2 } });
  });

  // Drawing: press the button, then click-drag on the map.
  let drawing = false;
  let start: maplibregl.LngLat | null = null;
  const boundsFrom = (a: maplibregl.LngLat, b: maplibregl.LngLat): LngLatBounds => ({
    west: Math.min(a.lng, b.lng),
    east: Math.max(a.lng, b.lng),
    south: Math.min(a.lat, b.lat),
    north: Math.max(a.lat, b.lat),
  });
  const stopDrawing = () => {
    drawing = false;
    start = null;
    map.dragPan.enable();
    map.getCanvas().style.cursor = '';
  };

  map.on('mousedown', (e) => {
    if (!drawing) return;
    e.preventDefault();
    start = e.lngLat;
  });
  map.on('mousemove', (e) => {
    if (drawing && start) render(boundsFrom(start, e.lngLat));
  });
  map.on('mouseup', (e) => {
    if (!drawing || !start) return;
    const b = boundsFrom(start, e.lngLat);
    stopDrawing();
    if (b.east - b.west > 1e-5 && b.north - b.south > 1e-5) onSelect(b);
  });

  return {
    map,
    setSelection(b, fit = false) {
      render(b);
      if (b && fit) map.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 60, duration: 1200 });
    },
    startDrawing() {
      drawing = true;
      map.dragPan.disable();
      map.getCanvas().style.cursor = 'crosshair';
    },
  };
}
