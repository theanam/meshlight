import type { Axis, CutKeep, CutPlane } from '../core/edit'
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

/** One editing step. Each is a whole operation the user can name and undo,
 *  not a stroke — "scale this part to 120%", not "move these vertices". */
export type EditOp =
  | { kind: 'delete'; shell: number }
  | { kind: 'scale'; shell: number | null; factor: [number, number, number] }
  | { kind: 'rotate'; shell: number | null; axis: Axis; degrees: number }
  | { kind: 'cut'; shell: number | null; plane: CutPlane; keep: CutKeep }

export interface HistoryState {
  canUndo: boolean
  canRedo: boolean
  /** Edits made since the file was opened. Zero means untouched. */
  depth: number
  /** Net edits since the last apply. Negative after undoing back past one. */
  pending: number
  /** Whether the Edit tab's mesh differs from the one the rest of the app is
   *  describing. The count above can be zero while this is true. */
  unapplied: boolean
}

/** The Edit tab's working mesh: enough to draw it and to select a part, and
 *  deliberately no more. There is no score, no issue list and no defect
 *  highlights here because none of those have been computed — they are what
 *  applying the edits buys you. */
export interface DraftPayload {
  positions: Float32Array
  indices: Uint32Array
  shellIds: Uint32Array
  bounds: Bounds
  triangleCount: number
  vertexCount: number
  shellCount: number
}

/** What an edit did, in the fewest words that are still true. Shown once in
 *  the panel so the user can tell a cut that caught the model from one that
 *  missed it, without reading the triangle count. */
export interface EditOutcome {
  label: string
  detail: string
}

export type WorkerRequest =
  | { type: 'load'; buffer: ArrayBuffer; settings: Settings; fileName: string }
  | { type: 'section'; z: number }
  | { type: 'rescore'; settings: Settings }
  | { type: 'repair'; options: RepairOptions }
  | { type: 'exportRepair'; options: RepairOptions }
  | { type: 'edit'; op: EditOp }
  | { type: 'history'; direction: 'undo' | 'redo' }
  /** Promote the Edit tab's working mesh to the one the whole app describes. */
  | { type: 'apply' }
  /** Put every tab back to the file as it was opened. */
  | { type: 'reset' }
  /** Write out the whole mesh, or one part of it, as STL. */
  | { type: 'exportMesh'; shell: number | null }

export type WorkerResponse =
  | { type: 'progress'; stage: string; fraction: number }
  | { type: 'loaded'; payload: LoadedPayload }
  | { type: 'section'; z: number; segments: Float32Array }
  | { type: 'scored'; score: Score; readiness: Readiness }
  | { type: 'repaired'; preview: RepairPreview }
  /** `suffix` names the file: the download is `<source>-<suffix>.stl`. */
  | { type: 'exported'; stl: ArrayBuffer; suffix: string }
  /** An edit landed on the working mesh. Nothing else in the app moves. */
  | { type: 'drafted'; draft: DraftPayload; history: HistoryState; outcome: EditOutcome }
  /** The working mesh became the model: re-analysed, re-scored, and now what
   *  Report, Fix and Cutaway are talking about. */
  | { type: 'applied'; payload: LoadedPayload; history: HistoryState; outcome: EditOutcome }
  /** The edit was declined and nothing changed — a cut that missed, a delete
   *  that would empty the scene. Not an error: the mesh is still fine. */
  | { type: 'editRefused'; message: string }
  | { type: 'error'; message: string }
