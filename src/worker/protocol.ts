import type { LngLatBounds } from '../core/geo';
import type { MeshOptions } from '../core/mesh';
import type { TrophyOptions } from '../core/trophy';

export interface PlaqueText {
  name: string;
  subtitle: string;
  includeElevation: boolean;
  allCaps: boolean;
  style: 'raised' | 'engraved';
}

export interface BuildRequest {
  type: 'build';
  id: number;
  bounds: LngLatBounds;
  cols: number;
  rows: number;
  mesh: MeshOptions;
  trophy: Omit<TrophyOptions, 'text'>;
  text: PlaqueText | null;
  minCapHeightMm: number;
}

export interface ExportRequest {
  type: 'export';
  id: number;
}

export type WorkerRequest = BuildRequest | ExportRequest;

export interface DemSummary {
  minM: number;
  maxM: number;
  groundWidthM: number;
  groundHeightM: number;
}

export interface BuildResult {
  /** Non-indexed triangles with creased normals, ready for three.js. */
  preview: { positions: Float32Array; normals: Float32Array };
  sizeMm: [number, number, number];
  triangleCount: number;
  dem: DemSummary;
  warnings: string[];
  /** Time spent building geometry, and downloading elevation (0 when cached). */
  buildMs: number;
  downloadMs: number;
}

export type WorkerMessage =
  | { id: number; type: 'progress'; message: string }
  | { id: number; type: 'done'; result: BuildResult }
  | { id: number; type: 'stl'; stl: ArrayBuffer; triangleCount: number }
  | { id: number; type: 'error'; message: string };
