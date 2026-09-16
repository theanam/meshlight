/** Shared types for the parse -> index -> analyse -> render pipeline (spec §7).
 *  Every stage here is a pure function over typed arrays and knows nothing
 *  about Three.js or the DOM, so each can be tested in isolation. */

export interface RawMesh {
  /** Non-indexed triangle soup, 9 floats per triangle. */
  positions: Float32Array
  /** Per-triangle normal as written in the file, 3 floats per triangle. */
  fileNormals: Float32Array
  triangleCount: number
  /** Human-readable source format, e.g. "STL (binary)" or "OBJ". */
  format: string
}

export interface IndexedMesh {
  /** Unique vertices, 3 floats each. */
  positions: Float32Array
  /** Triangle corners as vertex indices, 3 per triangle. */
  indices: Uint32Array
  vertexCount: number
  triangleCount: number
  bounds: Bounds
}

export interface Bounds {
  min: [number, number, number]
  max: [number, number, number]
  size: [number, number, number]
  center: [number, number, number]
}

export interface Adjacency {
  /** Packed edge list: 2 vertex indices per edge. */
  edges: Uint32Array
  /** How many triangles reference each edge. */
  edgeUseCount: Uint8Array
  /** Up to 2 triangles per edge; 0xFFFFFFFF marks an empty slot.
   *  Edges used by 3+ triangles keep only the first two here; the use count
   *  still records the true figure, which is what flags them non-manifold. */
  edgeTriangles: Uint32Array
  /** Edge index for each of a triangle's 3 sides, 3 per triangle. */
  triEdges: Uint32Array
  edgeCount: number
}

export interface Shell {
  /** Triangle indices belonging to this connected component. */
  triangles: Uint32Array
  /** Signed volume; negative means the shell is inside-out. */
  signedVolume: number
  bounds: Bounds
}

export type IssueKind =
  | 'non-manifold'
  | 'boundary'
  | 'flipped'
  | 'degenerate'
  | 'shells'

/** One concrete occurrence of a defect — a single bad edge, face or shell —
 *  so the report can zoom to each one rather than to their average. */
export interface DefectInstance {
  /** Mono-set label, e.g. "12.40, 8.00, 31.50". */
  label: string
  /** Secondary detail, e.g. a span in mm or a triangle count. */
  meta: string
  focus: [number, number, number]
  /** Roughly half the defect's extent, in mm. The camera uses this to pick a
   *  distance that frames the defect instead of flying inside the solid. */
  radius: number
}

export interface Issue {
  kind: IssueKind
  /** Short title, e.g. "Not watertight". */
  title: string
  /** One sentence: name the fact, then the consequence (brand kit, Voice). */
  detail: string
  count: number
  /** 'error' drives the red/orange pills; 'note' is informational. */
  severity: 'error' | 'note'
  /** Where to send the camera when the row itself is clicked. */
  focus?: [number, number, number]
  /** Individually clickable occurrences, capped at MAX_INSTANCES. */
  instances: DefectInstance[]
  /** How many occurrences exist beyond the ones listed. */
  hiddenInstances: number
}

/** A mesh can have tens of thousands of bad edges. Listing them all would
 *  build a DOM nobody can scroll; this many is plenty to work through. */
export const MAX_INSTANCES = 200

export interface Analysis {
  issues: Issue[]
  watertight: boolean
  /** Edges used by exactly one triangle. */
  boundaryEdges: Uint32Array
  /** Edges used by three or more triangles. */
  nonManifoldEdges: Uint32Array
  /** Triangle indices whose winding disagrees with their neighbours. */
  flippedTriangles: Uint32Array
  degenerateTriangles: Uint32Array
  shells: Shell[]
  elapsedMs: number
}

export interface ScoreComponent {
  label: string
  /** 0..1 before weighting. */
  ratio: number
  weight: number
  /** Human-readable consequence, shown under the label. */
  note: string
  /** What to actually do about it. Shown when this is the weakest component,
   *  so the headline tells you the next move rather than a points tally. */
  help: string
  status: 'pass' | 'warn' | 'fail'
}

export interface Score {
  total: number
  verdict: string
  components: ScoreComponent[]
}

export interface Settings {
  /** Build volume in mm, used for the fits-on-plate component. */
  buildVolume: [number, number, number]
  /** Nozzle diameter in mm; thin-wall threshold derives from this. */
  nozzleDiameter: number
  /** Overhang angle in degrees measured from the build plate normal. */
  overhangThreshold: number
  /** Vertices closer than this are welded during indexing. */
  weldEpsilon: number
  /** Which build plate is drawn under the model: a preset id from
   *  ui/plates.ts, 'custom' for the numbers above, or 'none' for no plate.
   *  It selects a bed to draw; buildVolume is what the score reads either
   *  way, so turning the plate off never changes the score. */
  platePreset: string
  /** Which colour the model is drawn in: an id from render/palette.ts. Purely
   *  how the mesh looks — nothing downstream of it reads this. */
  surfaceColor: string
}

export const DEFAULT_SETTINGS: Settings = {
  buildVolume: [220, 220, 250],
  nozzleDiameter: 0.4,
  overhangThreshold: 45,
  weldEpsilon: 1e-4,
  platePreset: 'none',
  surfaceColor: 'slate',
}
