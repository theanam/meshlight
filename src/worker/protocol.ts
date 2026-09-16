import type { Readiness } from '../core/readiness'
import type { RepairOptions, RepairStats } from '../core/repair'
import type { Bounds, Issue, Score, Settings } from '../core/types'

export interface Highlights {
  /** Line segments, 6 floats per segment. */
  boundary: Float32Array
  nonManifold: Float32Array
  /** Triangles, 9 floats per face. */
  flipped: Float32Array
  degenerate: Float32Array
}

export interface LoadedPayload {
  format: string
  byteLength: number
  triangleCount: number
  vertexCount: number
  bounds: Bounds
  positions: Float32Array
  indices: Uint32Array
  /** Which shell each triangle belongs to, one entry per triangle. Lets the
   *  renderer isolate a shell without shipping every shell's geometry. */
  shellIds: Uint32Array
  issues: Issue[]
  watertight: boolean
  shellCount: number
  elapsedMs: number
  score: Score
  /** Practical print checks — detail size, supports, adhesion, fit. */
  readiness: Readiness
  highlights: Highlights
}

/** Everything the viewport and the Fix panel need to show a repair without
 *  it having been written anywhere yet. */
export interface RepairPreview {
  stats: RepairStats
  triangleCount: number
  positions: Float32Array
  indices: Uint32Array
  shellIds: Uint32Array
  /** The triangles the repair added, drawn in mint over the result. */
  patch: Float32Array
  score: Score
  watertight: boolean
  /** Issues remaining after the repair — 0 means it came out clean. */
  remainingIssues: number
}

export type WorkerRequest =
  | { type: 'load'; buffer: ArrayBuffer; settings: Settings; fileName: string }
  | { type: 'section'; z: number }
  | { type: 'rescore'; settings: Settings }
  | { type: 'repair'; options: RepairOptions }
  | { type: 'exportRepair'; options: RepairOptions }

export type WorkerResponse =
  | { type: 'progress'; stage: string; fraction: number }
  | { type: 'loaded'; payload: LoadedPayload }
  | { type: 'section'; z: number; segments: Float32Array }
  | { type: 'scored'; score: Score; readiness: Readiness }
  | { type: 'repaired'; preview: RepairPreview }
  | { type: 'exported'; stl: ArrayBuffer }
  | { type: 'error'; message: string }
