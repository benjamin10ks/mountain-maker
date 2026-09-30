import type { LngLatBounds } from '../core/geo';
import type { MeshOptions, TerrainMesh } from '../core/mesh';

export interface BuildRequest {
  id: number;
  bounds: LngLatBounds;
  cols: number;
  rows: number;
  mesh: MeshOptions;
}

export interface DemSummary {
  minM: number;
  maxM: number;
  groundWidthM: number;
  groundHeightM: number;
}

export type WorkerMessage =
  | { id: number; type: 'progress'; message: string }
  | { id: number; type: 'done'; mesh: TerrainMesh; dem: DemSummary }
  | { id: number; type: 'error'; message: string };
