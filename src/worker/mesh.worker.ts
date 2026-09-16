/// <reference lib="webworker" />
import { analyseMesh, buildAdjacency, findShells } from '../core/analysis'
import { cutPart, deleteShell, extractShell, rotatePart, scalePart } from '../core/edit'
import { indexMesh } from '../core/indexer'
import { repairMesh, toBinaryStl } from '../core/repair'
import type { RepairOptions } from '../core/repair'
import { assessReadiness } from '../core/readiness'
import { scoreMesh } from '../core/score'
import { buildZBuckets, sectionAt } from '../core/section'
import { MeshParseError } from '../core/formats/errors'
import { parseMesh } from '../core/mesh-loader'
import { DEFAULT_SETTINGS } from '../core/types'
import type { Adjacency, Analysis, IndexedMesh, Score, Settings } from '../core/types'
import type {
  DraftPayload,
  EditOp,
  EditOutcome,
  HistoryState,
  LoadedPayload,
  RepairPreview,
  WorkerRequest,
  WorkerResponse,
} from './protocol'

// The worker keeps the only copy of the mesh. The main thread holds render
// buffers and nothing else, so slice queries never cross a structured clone.
//
// `mesh` is the applied model: the one the Report, the Fix panel, the score
// and the Cutaway all describe. `working` is the Edit tab's copy of it. They
// are the same object until an edit is made and the same object again once it
// is applied, which is exactly what "unapplied changes" means here.
let mesh: IndexedMesh | null = null
let working: IndexedMesh | null = null
let adjacency: Adjacency | null = null
let analysis: Analysis | null = null
let buckets: Uint32Array[] = []
let settings: Settings = DEFAULT_SETTINGS
/** The last previewed repair, held so an export writes exactly what was
 *  shown rather than recomputing and possibly drifting from it. */
let repaired: IndexedMesh | null = null
let repairedFor = ''

/** What the file said it was, kept across edits so the chip goes on naming
 *  the source format rather than switching to "edited" once you touch it. */
let sourceFormat = ''
let sourceBytes = 0
/** One entry per triangle of the applied mesh, rebuilt with every analysis.
 *  What the Report's shell rows and the viewport's part picking are keyed by. */
let shellIds: Uint32Array = new Uint32Array(0)
/** The same, for the working mesh. Edits are addressed by shell, so this is
 *  what turns the part you clicked in the Edit tab into triangles. */
let workingShellIds: Uint32Array = new Uint32Array(0)

/** The mesh exactly as the file was read, kept so discarding every edit is a
 *  single step rather than a re-parse. It also means reset can be undone like
 *  anything else: the current mesh goes on the undo stack on the way past. */
let original: IndexedMesh | null = null

/** Undo is a stack of whole meshes rather than inverse operations: every
 *  edit is already a pure function returning a new mesh, so keeping the old
 *  one is both simpler and exact. A cut is not invertible any other way.
 *
 *  Each entry carries the edit count that was current when that mesh was, so
 *  stepping back through a reset restores the depth it had before, not one
 *  less than whatever it happens to be now. */
interface HistoryEntry {
  mesh: IndexedMesh
  depth: number
}

const undoStack: HistoryEntry[] = []
const redoStack: HistoryEntry[] = []
/** Meshes are megabytes each, so history is capped by memory as well as by
 *  count — whichever runs out first. Roughly 192 MB of geometry, which is
 *  tens of steps on an ordinary part and a handful on a huge one. */
const HISTORY_STEPS = 24
const HISTORY_BYTES = 192 * 1024 * 1024

function meshBytes(m: IndexedMesh): number {
  return m.positions.byteLength + m.indices.byteLength
}

function trimHistory(): void {
  let total = undoStack.reduce((sum, entry) => sum + meshBytes(entry.mesh), 0)
  while (undoStack.length > HISTORY_STEPS || (undoStack.length > 1 && total > HISTORY_BYTES)) {
    total -= meshBytes(undoStack.shift()!.mesh)
  }
}

/** Edits applied since the file was opened. Counted separately from the undo
 *  stack because trimming that stack for memory must not make an edited mesh
 *  look untouched. */
let editDepth = 0

/** editDepth as it stood the last time the working mesh was applied. The
 *  difference between the two is what the Edit tab's badge counts. */
let appliedDepth = 0

function historyState(): HistoryState {
  return {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    depth: editDepth,
    pending: editDepth - appliedDepth,
    // Identity, not a count: undoing back past an apply leaves a mesh that
    // differs from the applied one while the count reads zero or less.
    unapplied: working !== mesh,
  }
}

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  ;(self as DedicatedWorkerGlobalScope).postMessage(message, transfer)
}

/** Expand edge indices into a flat line-segment buffer Three.js can draw. */
function edgeLines(m: IndexedMesh, adj: Adjacency, edges: Uint32Array): Float32Array {
  const out = new Float32Array(edges.length * 6)
  edges.forEach((edge, i) => {
    const a = adj.edges[edge * 2]!, b = adj.edges[edge * 2 + 1]!
    out[i * 6 + 0] = m.positions[a * 3]!
    out[i * 6 + 1] = m.positions[a * 3 + 1]!
    out[i * 6 + 2] = m.positions[a * 3 + 2]!
    out[i * 6 + 3] = m.positions[b * 3]!
    out[i * 6 + 4] = m.positions[b * 3 + 1]!
    out[i * 6 + 5] = m.positions[b * 3 + 2]!
  })
  return out
}

/** Expand triangle indices into a flat position buffer. */
function faceTriangles(m: IndexedMesh, triangles: Uint32Array): Float32Array {
  const out = new Float32Array(triangles.length * 9)
  triangles.forEach((t, i) => {
    for (let corner = 0; corner < 3; corner++) {
      const v = m.indices[t * 3 + corner]!
      out[i * 9 + corner * 3 + 0] = m.positions[v * 3]!
      out[i * 9 + corner * 3 + 1] = m.positions[v * 3 + 1]!
      out[i * 9 + corner * 3 + 2] = m.positions[v * 3 + 2]!
    }
  })
  return out
}

/** Flatten the shell lists into one entry per triangle. */
function shellIdsFor(triangleCount: number, shells: { triangles: Uint32Array }[]): Uint32Array {
  const ids = new Uint32Array(triangleCount)
  shells.forEach((shell, index) => {
    for (const t of shell.triangles) ids[t] = index
  })
  return ids
}

/** Re-derive everything that hangs off the mesh and package it for the main
 *  thread.
 *
 *  Loading a file and applying an edit both land here. That is the point: an
 *  edited mesh is analysed, scored and drawn by exactly the same code as a
 *  freshly opened one, so a cut part cannot end up with a stale score or an
 *  issue list describing the shape it used to be. */
function rebuild(onProgress?: (stage: string, fraction: number) => void): LoadedPayload {
  const current = mesh!
  workingShellIds = shellIds
  adjacency = buildAdjacency(current)
  buckets = buildZBuckets(current)
  analysis = analyseMesh(current, onProgress)
  shellIds = shellIdsFor(current.triangleCount, analysis.shells)

  const score: Score = scoreMesh(current, analysis, buckets, settings)
  const readiness = assessReadiness(current, analysis, buckets, settings)

  return {
    format: sourceFormat,
    byteLength: sourceBytes,
    triangleCount: current.triangleCount,
    vertexCount: current.vertexCount,
    bounds: current.bounds,
    // Copies, deliberately. These buffers are transferred below, which
    // detaches them in whichever context does not own them — and the worker
    // has to keep a working mesh to answer section, edit and rescore requests.
    positions: current.positions.slice(),
    indices: current.indices.slice(),
    shellIds: shellIds.slice(),
    issues: analysis.issues,
    watertight: analysis.watertight,
    shellCount: analysis.shells.length,
    elapsedMs: analysis.elapsedMs,
    score,
    readiness,
    highlights: {
      boundary: edgeLines(current, adjacency, analysis.boundaryEdges),
      nonManifold: edgeLines(current, adjacency, analysis.nonManifoldEdges),
      flipped: faceTriangles(current, analysis.flippedTriangles),
      degenerate: faceTriangles(current, analysis.degenerateTriangles),
    },
  }
}

/** Everything in a payload that is safe to hand over rather than clone: all
 *  of it is either a copy made in rebuild or a highlight buffer nothing here
 *  reads again. */
function payloadBuffers(payload: LoadedPayload): Transferable[] {
  return [
    payload.positions.buffer,
    payload.indices.buffer,
    payload.shellIds.buffer,
    payload.highlights.boundary.buffer,
    payload.highlights.nonManifold.buffer,
    payload.highlights.flipped.buffer,
    payload.highlights.degenerate.buffer,
  ]
}

async function handleLoad(buffer: ArrayBuffer, incoming: Settings, fileName: string): Promise<void> {
  settings = incoming

  post({ type: 'progress', stage: 'Reading file', fraction: 0.05 })
  // 3MF has to inflate its container first, so reading is asynchronous now.
  const raw = await parseMesh(buffer, fileName)

  post({ type: 'progress', stage: 'Welding vertices', fraction: 0.2 })
  mesh = indexMesh(raw, settings.weldEpsilon)
  repaired = null
  repairedFor = ''
  sourceFormat = raw.format
  sourceBytes = buffer.byteLength
  original = mesh
  working = mesh

  // Opening a file is the one thing that throws the edit history away: there
  // is nothing left for it to undo onto.
  undoStack.length = 0
  redoStack.length = 0
  editDepth = 0
  appliedDepth = 0

  const payload = rebuild((stage, fraction) => {
    // Analysis owns the back half of the progress bar.
    post({ type: 'progress', stage, fraction: 0.3 + fraction * 0.5 })
  })

  post({ type: 'progress', stage: 'Handing over', fraction: 0.95 })
  post({ type: 'loaded', payload }, payloadBuffers(payload))
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function keyFor(options: RepairOptions): string {
  return `${options.fillHoles}|${options.fixWinding}|${options.dropDegenerate}`
}

/** Apply the repair and re-run the full analysis on the result, so the score
 *  and the remaining-issue count are measured rather than predicted.
 *
 *  Repairs run on the applied mesh, not the Edit tab's working copy: the Fix
 *  panel describes the model everyone else can see, and offering to repair
 *  geometry that has not been applied yet would be answering about a mesh the
 *  panel is not showing. */
function buildRepair(options: RepairOptions): RepairPreview {
  const result = repairMesh(mesh!, options)
  repaired = result.mesh
  repairedFor = keyFor(options)

  const analysed = analyseMesh(result.mesh)
  const zBuckets = buildZBuckets(result.mesh)

  return {
    stats: result.stats,
    triangleCount: result.mesh.triangleCount,
    positions: result.mesh.positions.slice(),
    indices: result.mesh.indices.slice(),
    shellIds: shellIdsFor(result.mesh.triangleCount, analysed.shells),
    patch: result.patch,
    score: scoreMesh(result.mesh, analysed, zBuckets, settings),
    watertight: analysed.watertight,
    remainingIssues: analysed.issues.length,
  }
}

/** Run one operation, replacing the working mesh, and say what it did.
 *
 *  Returning a string instead of an outcome means "refused, and here is why":
 *  a cut that missed the model or a delete that would empty the scene should
 *  leave the mesh — and the undo stack — exactly as they were. */
function runEdit(op: EditOp): EditOutcome | string {
  const current = working!

  switch (op.kind) {
    case 'delete': {
      const next = deleteShell(current, workingShellIds, op.shell)
      if (next.triangleCount === 0) {
        return 'That is the only part left — deleting it would leave nothing to work on.'
      }
      const removed = current.triangleCount - next.triangleCount
      working = next
      return {
        label: `Deleted part ${op.shell + 1}`,
        detail: `${removed.toLocaleString()} triangles removed`,
      }
    }

    case 'scale': {
      working = scalePart(current, workingShellIds, op.shell, op.factor)
      const percent = Math.round(op.factor[0] * 100)
      const size = working.bounds.size.map((n) => n.toFixed(1)).join(' × ')
      return {
        label: `Scaled to ${percent}%`,
        detail: `${op.shell === null ? 'model' : `part ${op.shell + 1}`} · now ${size} mm overall`,
      }
    }

    case 'rotate': {
      working = rotatePart(current, workingShellIds, op.shell, op.axis, op.degrees)
      const size = working.bounds.size.map((n) => n.toFixed(1)).join(' × ')
      return {
        label: `Turned ${op.degrees}° about ${'XYZ'[op.axis]}`,
        detail: `${op.shell === null ? 'model' : `part ${op.shell + 1}`} · now ${size} mm overall`,
      }
    }

    case 'cut': {
      const result = cutPart(current, workingShellIds, op.shell, op.plane, op.keep, settings.weldEpsilon)
      if (result.splitTriangles === 0) {
        return 'That line missed the model. Draw it across the part you want to cut.'
      }
      working = result.mesh
      const kept =
        op.keep === 'both' ? 'kept both halves' : `kept the ${op.keep === 'front' ? 'near' : 'far'} half`
      return {
        label: 'Cut along the line',
        detail: `${result.splitTriangles.toLocaleString()} triangles split · ${result.capTriangles.toLocaleString()} added to close the face · ${kept}`,
      }
    }
  }
}

/** Package the working mesh for the Edit tab.
 *
 *  Shells only. The issue list, the highlights, the readiness checks and the
 *  score all describe the applied model, and recomputing them on a mesh that
 *  is still being worked on would be both wasted effort and a lie — the panel
 *  they feed is not showing this geometry yet. */
function draftPayload(): DraftPayload {
  const current = working!
  workingShellIds = shellIdsFor(current.triangleCount, findShells(current))

  return {
    positions: current.positions.slice(),
    indices: current.indices.slice(),
    shellIds: workingShellIds.slice(),
    bounds: current.bounds,
    triangleCount: current.triangleCount,
    vertexCount: current.vertexCount,
    shellCount: new Set(workingShellIds).size,
  }
}

function postDraft(outcome: EditOutcome): void {
  const draft = draftPayload()
  post({ type: 'drafted', draft, history: historyState(), outcome }, [
    draft.positions.buffer,
    draft.indices.buffer,
    draft.shellIds.buffer,
  ])
}

function applyEdit(op: EditOp): void {
  if (!working) return
  post({ type: 'progress', stage: 'Editing', fraction: 0.3 })

  const before = working
  const outcome = runEdit(op)
  if (typeof outcome === 'string') {
    post({ type: 'editRefused', message: outcome })
    return
  }

  undoStack.push({ mesh: before, depth: editDepth })
  redoStack.length = 0
  editDepth++
  trimHistory()

  postDraft(outcome)
}

function stepHistory(direction: 'undo' | 'redo'): void {
  if (!working) return
  const from = direction === 'undo' ? undoStack : redoStack
  const onto = direction === 'undo' ? redoStack : undoStack
  const previous = from.pop()
  if (!previous) return

  onto.push({ mesh: working, depth: editDepth })
  working = previous.mesh
  editDepth = previous.depth

  postDraft({
    label: direction === 'undo' ? 'Undone' : 'Redone',
    detail:
      working === mesh
        ? 'back to the applied model'
        : `${Math.abs(editDepth - appliedDepth)} change${Math.abs(editDepth - appliedDepth) === 1 ? '' : 's'} not applied`,
  })
}

/** Promote the working mesh to the model everything else describes.
 *
 *  This is the only point at which the Report, the score, the Fix panel and
 *  the Cutaway see an edit — and it is still only the copy held in this tab.
 *  Nothing is written to the file the mesh came from; that is what Export is
 *  for, and the button says so. */
function applyToModel(): void {
  if (!working || working === mesh) return

  const changed = Math.abs(editDepth - appliedDepth)
  mesh = working
  appliedDepth = editDepth
  // The previewed repair described the mesh as it was before all this.
  repaired = null
  repairedFor = ''

  post({ type: 'progress', stage: 'Re-checking', fraction: 0.5 })
  const payload = rebuild()
  working = mesh

  post(
    {
      type: 'applied',
      payload,
      history: historyState(),
      outcome: {
        label: `Applied ${changed} change${changed === 1 ? '' : 's'} to the model`,
        detail: `report, score and fix now describe this mesh · ${payload.triangleCount.toLocaleString()} tri · nothing written to disk`,
      },
    },
    payloadBuffers(payload),
  )
}

/** Put every tab back to the file as it was opened. */
function resetToOriginal(): void {
  if (!original || (working === original && mesh === original)) return

  const discarded = editDepth
  undoStack.push({ mesh: working!, depth: editDepth })
  redoStack.length = 0
  trimHistory()

  mesh = original
  working = original
  editDepth = 0
  appliedDepth = 0
  repaired = null
  repairedFor = ''

  const payload = rebuild()
  working = mesh

  post(
    {
      type: 'applied',
      payload,
      history: historyState(),
      outcome: {
        label: 'Discarded every edit',
        detail: `back to the file as opened · ${discarded} edit${discarded === 1 ? '' : 's'} dropped, Undo brings them back`,
      },
    },
    payloadBuffers(payload),
  )
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  try {
    switch (request.type) {
      case 'load':
        void handleLoad(request.buffer, request.settings, request.fileName).catch(reportError)
        break

      case 'section': {
        if (!mesh) return
        const segments = sectionAt(mesh, buckets, request.z)
        post({ type: 'section', z: request.z, segments }, [segments.buffer])
        break
      }

      case 'repair': {
        if (!mesh) return
        post({ type: 'repaired', preview: buildRepair(request.options) })
        break
      }

      case 'exportRepair': {
        if (!mesh) return
        // Reuse the previewed mesh when the options have not moved on, so
        // what lands in Downloads is what was on screen.
        if (!repaired || repairedFor !== keyFor(request.options)) buildRepair(request.options)
        if (!repaired) return
        const stl = toBinaryStl(repaired, 'Repaired by Meshlight')
        post({ type: 'exported', stl, suffix: 'fixed' }, [stl])
        break
      }

      case 'edit':
        applyEdit(request.op)
        break

      case 'history':
        stepHistory(request.direction)
        break

      case 'apply':
        applyToModel()
        break

      case 'reset':
        resetToOriginal()
        break

      case 'exportMesh': {
        if (!mesh || !working) return
        // A part is written out in the model's own coordinates rather than
        // moved to the origin: it has to go back beside its neighbours, and
        // re-centring it here would quietly throw that away.
        const source = working ?? mesh
        const target =
          request.shell === null ? source : extractShell(source, workingShellIds, request.shell)
        const stl = toBinaryStl(target, 'Edited in Meshlight')
        post(
          { type: 'exported', stl, suffix: request.shell === null ? 'edited' : `part-${request.shell + 1}` },
          [stl],
        )
        break
      }

      case 'rescore': {
        if (!mesh || !analysis) return
        settings = request.settings
        // Both depend on nozzle diameter, overhang angle and build volume, so
        // a settings change has to redo the pair of them.
        post({
          type: 'scored',
          score: scoreMesh(mesh, analysis, buckets, settings),
          readiness: assessReadiness(mesh, analysis, buckets, settings),
        })
        break
      }
    }
  } catch (error) {
    reportError(error)
  }
}

/** A parse failure is the user's problem to understand, so pass its own
 *  wording through; anything else gets a generic wrapper. */
function reportError(error: unknown): void {
  const message =
    error instanceof MeshParseError
      ? error.message
      : error instanceof Error
        ? `Could not read that file — ${error.message}`
        : 'Could not read that file.'
  post({ type: 'error', message })
}
