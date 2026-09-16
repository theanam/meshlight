import { NO_TRIANGLE, buildAdjacency, traversesForward } from './adjacency'
import { degenerateAreaFloor, triangleArea } from './analysis'
import { computeBounds } from './indexer'
import { earClip } from './polygon'
import type { IndexedMesh } from './types'

/** Which repairs to apply. Each one is independent and reversible by simply
 *  not selecting it — the original mesh is never mutated (spec §6.1). */
export interface RepairOptions {
  fillHoles: boolean
  fixWinding: boolean
  dropDegenerate: boolean
}

export interface RepairStats {
  /** Boundary loops closed. */
  filledLoops: number
  /** Triangles added by hole filling. */
  addedTriangles: number
  /** Faces whose winding was reversed. */
  rewoundTriangles: number
  /** Zero-area faces removed. */
  removedTriangles: number
}

export interface RepairResult {
  mesh: IndexedMesh
  stats: RepairStats
  /** Positions of the triangles the repair added, for the mint preview. */
  patch: Float32Array
}

/** A working mesh whose arrays can grow. */
interface Draft {
  positions: number[]
  indices: number[]
}

function draftFrom(mesh: IndexedMesh): Draft {
  return { positions: Array.from(mesh.positions), indices: Array.from(mesh.indices) }
}

function toIndexed(draft: Draft): IndexedMesh {
  const positions = Float32Array.from(draft.positions)
  return {
    positions,
    indices: Uint32Array.from(draft.indices),
    vertexCount: positions.length / 3,
    triangleCount: draft.indices.length / 3,
    bounds: computeBounds(positions),
  }
}

// ---------------------------------------------------------------------------
// 1. Degenerate faces
// ---------------------------------------------------------------------------

/** Drop zero-area faces and faces whose corners collapsed onto one vertex.
 *  These carry no surface, but they do create phantom edges that make an
 *  otherwise clean mesh report as non-manifold. */
function dropDegenerate(draft: Draft, areaFloor: number): number {
  const positions = Float32Array.from(draft.positions)
  const kept: number[] = []
  let removed = 0

  for (let t = 0; t < draft.indices.length / 3; t++) {
    const a = draft.indices[t * 3]!, b = draft.indices[t * 3 + 1]!, c = draft.indices[t * 3 + 2]!
    if (a === b || b === c || c === a || triangleArea(positions, a, b, c) < areaFloor) {
      removed++
      continue
    }
    kept.push(a, b, c)
  }

  draft.indices = kept
  return removed
}

// ---------------------------------------------------------------------------
// 2. Winding
// ---------------------------------------------------------------------------

/** Make every face in a shell agree on which side is out, then make the shell
 *  itself face outward.
 *
 *  Walks each connected component propagating orientation across shared
 *  edges, takes the majority as correct, then checks the shell's signed
 *  volume: a consistently wound shell that still encloses negative volume is
 *  inside-out and gets reversed wholesale. */
function fixWinding(draft: Draft): number {
  const mesh = toIndexed(draft)
  const adj = buildAdjacency(mesh)
  const { indices, positions, triangleCount } = mesh

  const orientation = new Int8Array(triangleCount)
  const seen = new Uint8Array(triangleCount)
  const queue = new Uint32Array(triangleCount)
  const toFlip: number[] = []

  for (let seed = 0; seed < triangleCount; seed++) {
    if (seen[seed]) continue

    const members: number[] = []
    let head = 0, tail = 0
    queue[tail++] = seed
    seen[seed] = 1
    orientation[seed] = 1

    while (head < tail) {
      const t = queue[head++]!
      members.push(t)
      for (let side = 0; side < 3; side++) {
        const edge = adj.triEdges[t * 3 + side]!
        const lo = adj.edges[edge * 2]!, hi = adj.edges[edge * 2 + 1]!
        for (let slot = 0; slot < 2; slot++) {
          const n = adj.edgeTriangles[edge * 2 + slot]!
          if (n === NO_TRIANGLE || n === t || seen[n]) continue
          const same =
            traversesForward(indices, t, lo, hi) === traversesForward(indices, n, lo, hi)
          seen[n] = 1
          orientation[n] = ((same ? -1 : 1) * orientation[t]!) as 1 | -1
          queue[tail++] = n
        }
      }
    }

    let positives = 0
    for (const t of members) if (orientation[t] === 1) positives++
    const majority = positives * 2 >= members.length ? 1 : -1

    let volume = 0
    for (const t of members) {
      const a = indices[t * 3]!, b = indices[t * 3 + 1]!, c = indices[t * 3 + 2]!
      const ax = positions[a * 3]!, ay = positions[a * 3 + 1]!, az = positions[a * 3 + 2]!
      const bx = positions[b * 3]!, by = positions[b * 3 + 1]!, bz = positions[b * 3 + 2]!
      const cx = positions[c * 3]!, cy = positions[c * 3 + 1]!, cz = positions[c * 3 + 2]!
      const crossX = by * cz - bz * cy
      const crossY = bz * cx - bx * cz
      const crossZ = bx * cy - by * cx
      volume += (orientation[t]! * (ax * crossX + ay * crossY + az * crossZ)) / 6
    }

    // Relative to the majority, a face is wrong if it disagrees. If the whole
    // shell encloses negative volume it is inside-out, so the rule inverts.
    const shellInverted = volume < 0
    for (const t of members) {
      const agreesWithMajority = orientation[t] === majority
      if (shellInverted ? agreesWithMajority : !agreesWithMajority) toFlip.push(t)
    }
  }

  for (const t of toFlip) {
    const b = draft.indices[t * 3 + 1]!
    draft.indices[t * 3 + 1] = draft.indices[t * 3 + 2]!
    draft.indices[t * 3 + 2] = b
  }
  return toFlip.length
}

// ---------------------------------------------------------------------------
// 3. Hole filling
// ---------------------------------------------------------------------------

/** Chain boundary edges into closed loops.
 *
 *  Each boundary edge is used by exactly one triangle. The patch has to run
 *  the other way round that edge to be wound consistently with the surface it
 *  closes, so loops are built from the reversed direction. */
function boundaryLoops(mesh: IndexedMesh): number[][] {
  const adj = buildAdjacency(mesh)
  const next = new Map<number, number[]>()

  for (let e = 0; e < adj.edgeCount; e++) {
    if (adj.edgeUseCount[e] !== 1) continue
    const lo = adj.edges[e * 2]!, hi = adj.edges[e * 2 + 1]!
    const owner = adj.edgeTriangles[e * 2]!
    if (owner === NO_TRIANGLE) continue
    // Reverse the owner's traversal.
    const [from, to] = traversesForward(mesh.indices, owner, lo, hi) ? [hi, lo] : [lo, hi]
    const list = next.get(from)
    if (list) list.push(to)
    else next.set(from, [to])
  }

  const loops: number[][] = []
  while (next.size > 0) {
    const start = next.keys().next().value as number
    const loop: number[] = []
    let current = start

    while (true) {
      const options = next.get(current)
      if (!options || options.length === 0) break
      const step = options.pop()!
      if (options.length === 0) next.delete(current)
      loop.push(current)
      current = step
      if (current === start) break
      // A malformed boundary could otherwise walk forever.
      if (loop.length > mesh.vertexCount) break
    }

    if (loop.length >= 3) loops.push(loop)
  }
  return loops
}

/** Close every boundary loop. Returns loops filled and triangles added. */
function fillHoles(draft: Draft): { loops: number; added: number; patch: number[] } {
  const mesh = toIndexed(draft)
  const loops = boundaryLoops(mesh)
  const patch: number[] = []
  let added = 0

  for (const loop of loops) {
    let fan = earClip(mesh.positions, loop)

    if (fan === null) {
      // Fall back to a centroid fan: less tidy, but it always closes.
      const cx = loop.reduce((sum, i) => sum + mesh.positions[i * 3]!, 0) / loop.length
      const cy = loop.reduce((sum, i) => sum + mesh.positions[i * 3 + 1]!, 0) / loop.length
      const cz = loop.reduce((sum, i) => sum + mesh.positions[i * 3 + 2]!, 0) / loop.length
      const centre = draft.positions.length / 3
      draft.positions.push(cx, cy, cz)
      fan = loop.map((current, i) => [current, loop[(i + 1) % loop.length]!, centre])
    }

    for (const tri of fan) {
      draft.indices.push(tri[0]!, tri[1]!, tri[2]!)
      added++
      for (const corner of tri) {
        // Read from the draft: a fan may reference the centroid just added.
        patch.push(
          draft.positions[corner * 3]!,
          draft.positions[corner * 3 + 1]!,
          draft.positions[corner * 3 + 2]!,
        )
      }
    }
  }

  return { loops: loops.length, added, patch }
}

// ---------------------------------------------------------------------------

export function repairMesh(mesh: IndexedMesh, options: RepairOptions): RepairResult {
  const draft = draftFrom(mesh)
  const stats: RepairStats = {
    filledLoops: 0,
    addedTriangles: 0,
    rewoundTriangles: 0,
    removedTriangles: 0,
  }
  let patch: number[] = []

  // Order matters. Degenerate faces create phantom edges that would confuse
  // both the winding walk and boundary detection, so they go first. Winding
  // is settled before filling so each patch can be wound to match the surface
  // it closes rather than to a face that was itself reversed.
  if (options.dropDegenerate) {
    stats.removedTriangles = dropDegenerate(draft, degenerateAreaFloor(mesh))
  }
  if (options.fixWinding) {
    stats.rewoundTriangles = fixWinding(draft)
  }
  if (options.fillHoles) {
    const filled = fillHoles(draft)
    stats.filledLoops = filled.loops
    stats.addedTriangles = filled.added
    patch = filled.patch
  }

  return { mesh: toIndexed(draft), stats, patch: Float32Array.from(patch) }
}

/** Serialise a mesh back out as a binary STL, ready to download.
 *
 *  `note` goes in the 80-byte header. It says what produced the file, which
 *  is the only place an STL has to say anything at all — and "repaired" and
 *  "edited" are not the same claim. */
export function toBinaryStl(mesh: IndexedMesh, note = 'Written by Meshlight'): ArrayBuffer {
  const { indices, positions, triangleCount } = mesh
  const buffer = new ArrayBuffer(84 + triangleCount * 50)
  const view = new DataView(buffer)

  new Uint8Array(buffer, 0, 80).set(
    new TextEncoder().encode(`${note} — meshlight, MIT licensed`).slice(0, 80),
  )
  view.setUint32(80, triangleCount, true)

  let offset = 84
  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3]!, b = indices[t * 3 + 1]!, c = indices[t * 3 + 2]!
    const ax = positions[a * 3]!, ay = positions[a * 3 + 1]!, az = positions[a * 3 + 2]!
    const bx = positions[b * 3]!, by = positions[b * 3 + 1]!, bz = positions[b * 3 + 2]!
    const cx = positions[c * 3]!, cy = positions[c * 3 + 1]!, cz = positions[c * 3 + 2]!

    // Write a real facet normal this time; plenty of tools still read it.
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az
    let nx = e1y * e2z - e1z * e2y
    let ny = e1z * e2x - e1x * e2z
    let nz = e1x * e2y - e1y * e2x
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len; ny /= len; nz /= len

    view.setFloat32(offset, nx, true)
    view.setFloat32(offset + 4, ny, true)
    view.setFloat32(offset + 8, nz, true)
    const corners = [ax, ay, az, bx, by, bz, cx, cy, cz]
    for (let i = 0; i < 9; i++) view.setFloat32(offset + 12 + i * 4, corners[i]!, true)
    offset += 50
  }

  return buffer
}
