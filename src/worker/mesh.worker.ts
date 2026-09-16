/// <reference lib="webworker" />
import { analyseMesh, buildAdjacency } from '../core/analysis'
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
import type { LoadedPayload, RepairPreview, WorkerRequest, WorkerResponse } from './protocol'

// The worker keeps the only copy of the mesh. The main thread holds render
// buffers and nothing else, so slice queries never cross a structured clone.
let mesh: IndexedMesh | null = null
let adjacency: Adjacency | null = null
let analysis: Analysis | null = null
let buckets: Uint32Array[] = []
let settings: Settings = DEFAULT_SETTINGS
/** The last previewed repair, held so an export writes exactly what was
 *  shown rather than recomputing and possibly drifting from it. */
let repaired: IndexedMesh | null = null
let repairedFor = ''

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

async function handleLoad(buffer: ArrayBuffer, incoming: Settings, fileName: string): Promise<void> {
  settings = incoming

  post({ type: 'progress', stage: 'Reading file', fraction: 0.05 })
  // 3MF has to inflate its container first, so reading is asynchronous now.
  const raw = await parseMesh(buffer, fileName)

  post({ type: 'progress', stage: 'Welding vertices', fraction: 0.2 })
  mesh = indexMesh(raw, settings.weldEpsilon)
  repaired = null
  repairedFor = ''
  adjacency = buildAdjacency(mesh)

  post({ type: 'progress', stage: 'Bucketing by height', fraction: 0.3 })
  buckets = buildZBuckets(mesh)

  analysis = analyseMesh(mesh, (stage, fraction) => {
    // Analysis owns the back half of the progress bar.
    post({ type: 'progress', stage, fraction: 0.3 + fraction * 0.5 })
  })

  post({ type: 'progress', stage: 'Scoring printability', fraction: 0.85 })
  const score: Score = scoreMesh(mesh, analysis, buckets, settings)
  const readiness = assessReadiness(mesh, analysis, buckets, settings)

  post({ type: 'progress', stage: 'Handing over', fraction: 0.95 })
  const payload: LoadedPayload = {
    format: raw.format,
    byteLength: buffer.byteLength,
    triangleCount: mesh.triangleCount,
    vertexCount: mesh.vertexCount,
    bounds: mesh.bounds,
    // Copies, deliberately. These buffers are transferred below, which
    // detaches them in whichever context does not own them — and the worker
    // has to keep a working mesh to answer section and rescore requests.
    positions: mesh.positions.slice(),
    indices: mesh.indices.slice(),
    shellIds: shellIdsFor(mesh.triangleCount, analysis.shells),
    issues: analysis.issues,
    watertight: analysis.watertight,
    shellCount: analysis.shells.length,
    elapsedMs: analysis.elapsedMs,
    score,
    readiness,
    highlights: {
      boundary: edgeLines(mesh, adjacency, analysis.boundaryEdges),
      nonManifold: edgeLines(mesh, adjacency, analysis.nonManifoldEdges),
      flipped: faceTriangles(mesh, analysis.flippedTriangles),
      degenerate: faceTriangles(mesh, analysis.degenerateTriangles),
    },
  }

  // Transfer rather than clone (spec §7). Everything listed here is either a
  // copy made just above or a highlight buffer the worker never reads again.
  post({ type: 'loaded', payload }, [
    payload.positions.buffer,
    payload.indices.buffer,
    payload.shellIds.buffer,
    payload.highlights.boundary.buffer,
    payload.highlights.nonManifold.buffer,
    payload.highlights.flipped.buffer,
    payload.highlights.degenerate.buffer,
  ])
}

function keyFor(options: RepairOptions): string {
  return `${options.fillHoles}|${options.fixWinding}|${options.dropDegenerate}`
}

/** Apply the repair and re-run the full analysis on the result, so the score
 *  and the remaining-issue count are measured rather than predicted. */
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
        const stl = toBinaryStl(repaired)
        post({ type: 'exported', stl }, [stl])
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
