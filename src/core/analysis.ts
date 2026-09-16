import { NO_TRIANGLE, buildAdjacency, traversesForward } from './adjacency'
import { computeBounds } from './indexer'
import { MAX_INSTANCES } from './types'
import type { Adjacency, Analysis, DefectInstance, IndexedMesh, Issue, Shell } from './types'

export type ProgressFn = (stage: string, fraction: number) => void

/** Area below which a face carries no useful geometry. Scaled to the model so
 *  a 2 mm part and a 200 mm part are judged alike; shared with the repair
 *  pass so "what is degenerate" has exactly one definition. */
export function degenerateAreaFloor(mesh: IndexedMesh): number {
  const diagonal = Math.hypot(...mesh.bounds.size)
  return Math.max((diagonal * 1e-5) ** 2, Number.EPSILON)
}

export function triangleArea(p: Float32Array, a: number, b: number, c: number): number {
  const ax = p[a * 3]!, ay = p[a * 3 + 1]!, az = p[a * 3 + 2]!
  const bx = p[b * 3]! - ax, by = p[b * 3 + 1]! - ay, bz = p[b * 3 + 2]! - az
  const cx = p[c * 3]! - ax, cy = p[c * 3 + 1]! - ay, cz = p[c * 3 + 2]! - az
  const nx = by * cz - bz * cy
  const ny = bz * cx - bx * cz
  const nz = bx * cy - by * cx
  return Math.sqrt(nx * nx + ny * ny + nz * nz) / 2
}

function centroidOf(mesh: IndexedMesh, triangles: ArrayLike<number>): [number, number, number] {
  const { positions, indices } = mesh
  let x = 0, y = 0, z = 0
  const n = triangles.length
  if (n === 0) return [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const t = triangles[i]!
    for (let corner = 0; corner < 3; corner++) {
      const v = indices[t * 3 + corner]!
      x += positions[v * 3]!
      y += positions[v * 3 + 1]!
      z += positions[v * 3 + 2]!
    }
  }
  return [x / (n * 3), y / (n * 3), z / (n * 3)]
}

/** Midpoint of each listed edge, used to aim the camera at a defect. */
function edgeCentroid(mesh: IndexedMesh, adj: Adjacency, edges: Uint32Array): [number, number, number] {
  const { positions } = mesh
  let x = 0, y = 0, z = 0
  if (edges.length === 0) return [0, 0, 0]
  for (const edge of edges) {
    const a = adj.edges[edge * 2]!, b = adj.edges[edge * 2 + 1]!
    x += (positions[a * 3]! + positions[b * 3]!) / 2
    y += (positions[a * 3 + 1]! + positions[b * 3 + 1]!) / 2
    z += (positions[a * 3 + 2]! + positions[b * 3 + 2]!) / 2
  }
  return [x / edges.length, y / edges.length, z / edges.length]
}

/** Flood-fill the triangle adjacency graph into connected components, and
 *  while walking each one settle its winding (spec §5.3).
 *
 *  Doing both in a single traversal matters: relative orientation is only
 *  meaningful within a shell, so the BFS that discovers a shell is exactly
 *  the BFS that can propagate orientation through it. */
function findShellsAndWinding(mesh: IndexedMesh, adj: Adjacency) {
  const { triangleCount, indices, positions } = mesh
  const shellOf = new Int32Array(triangleCount).fill(-1)
  // +1 / -1 relative to whichever triangle seeded the shell.
  const orientation = new Int8Array(triangleCount)
  const shells: Shell[] = []
  const flipped: number[] = []

  const queue = new Uint32Array(triangleCount)

  for (let seed = 0; seed < triangleCount; seed++) {
    if (shellOf[seed] !== -1) continue

    const shellIndex = shells.length
    const members: number[] = []
    let head = 0, tail = 0
    queue[tail++] = seed
    shellOf[seed] = shellIndex
    orientation[seed] = 1

    while (head < tail) {
      const t = queue[head++]!
      members.push(t)

      for (let side = 0; side < 3; side++) {
        const edge = adj.triEdges[t * 3 + side]!
        const lo = adj.edges[edge * 2]!, hi = adj.edges[edge * 2 + 1]!
        for (let slot = 0; slot < 2; slot++) {
          const n = adj.edgeTriangles[edge * 2 + slot]!
          if (n === NO_TRIANGLE || n === t) continue

          // Same traversal direction on a shared edge means the two
          // triangles disagree about which side is "out".
          const sameDirection =
            traversesForward(indices, t, lo, hi) === traversesForward(indices, n, lo, hi)
          const relative = (sameDirection ? -1 : 1) * orientation[t]!

          if (shellOf[n] === -1) {
            shellOf[n] = shellIndex
            orientation[n] = relative as 1 | -1
            queue[tail++] = n
          }
        }
      }
    }

    // Signed volume of the shell under the seed's orientation. Negative means
    // the whole shell is inside-out (spec §5.3, inverted shell detection).
    let volume = 0
    let positives = 0
    for (const t of members) {
      if (orientation[t] === 1) positives++
      const a = indices[t * 3]!, b = indices[t * 3 + 1]!, c = indices[t * 3 + 2]!
      const ax = positions[a * 3]!, ay = positions[a * 3 + 1]!, az = positions[a * 3 + 2]!
      const bx = positions[b * 3]!, by = positions[b * 3 + 1]!, bz = positions[b * 3 + 2]!
      const cx = positions[c * 3]!, cy = positions[c * 3 + 1]!, cz = positions[c * 3 + 2]!
      const cross = [by * cz - bz * cy, bz * cx - bx * cz, bx * cy - by * cx]
      volume += (orientation[t]! * (ax * cross[0]! + ay * cross[1]! + az * cross[2]!)) / 6
    }

    // Triangles in the minority orientation are individually mis-wound.
    const majority = positives * 2 >= members.length ? 1 : -1
    for (const t of members) {
      if (orientation[t] !== majority) flipped.push(t)
    }
    // If the consistent majority still encloses negative volume, the shell as
    // a whole points inward and every one of its faces is flipped.
    if (volume < 0) {
      for (const t of members) {
        if (orientation[t] === majority) flipped.push(t)
      }
    }

    const shellPositions = new Float32Array(members.length * 9)
    members.forEach((t, i) => {
      for (let corner = 0; corner < 3; corner++) {
        const v = indices[t * 3 + corner]!
        shellPositions[i * 9 + corner * 3 + 0] = positions[v * 3]!
        shellPositions[i * 9 + corner * 3 + 1] = positions[v * 3 + 1]!
        shellPositions[i * 9 + corner * 3 + 2] = positions[v * 3 + 2]!
      }
    })

    shells.push({
      triangles: Uint32Array.from(members),
      signedVolume: volume,
      bounds: computeBounds(shellPositions),
    })
  }

  return { shells, flipped: Uint32Array.from(flipped) }
}

function fmtPoint(p: [number, number, number]): string {
  return p.map((n) => n.toFixed(2)).join(', ')
}

/** One clickable entry per bad edge, labelled by where it sits and how long
 *  it is — enough to tell two nearby defects apart in the list. */
function edgeInstances(mesh: IndexedMesh, adj: Adjacency, edges: Uint32Array): DefectInstance[] {
  const out: DefectInstance[] = []
  const limit = Math.min(edges.length, MAX_INSTANCES)
  for (let i = 0; i < limit; i++) {
    const edge = edges[i]!
    const a = adj.edges[edge * 2]!, b = adj.edges[edge * 2 + 1]!
    const ax = mesh.positions[a * 3]!, ay = mesh.positions[a * 3 + 1]!, az = mesh.positions[a * 3 + 2]!
    const bx = mesh.positions[b * 3]!, by = mesh.positions[b * 3 + 1]!, bz = mesh.positions[b * 3 + 2]!
    const mid: [number, number, number] = [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2]
    const length = Math.hypot(bx - ax, by - ay, bz - az)
    out.push({
      label: fmtPoint(mid),
      meta: `${length.toFixed(2)} mm`,
      focus: mid,
      radius: length / 2,
    })
  }
  return out
}

/** One clickable entry per bad face, labelled by centroid and area. */
function faceInstances(mesh: IndexedMesh, triangles: Uint32Array): DefectInstance[] {
  const out: DefectInstance[] = []
  const limit = Math.min(triangles.length, MAX_INSTANCES)
  for (let i = 0; i < limit; i++) {
    const t = triangles[i]!
    const a = mesh.indices[t * 3]!, b = mesh.indices[t * 3 + 1]!, c = mesh.indices[t * 3 + 2]!
    const centre = centroidOf(mesh, [t])
    const area = triangleArea(mesh.positions, a, b, c)
    out.push({
      label: fmtPoint(centre),
      meta: `${area.toFixed(3)} mm²`,
      focus: centre,
      // sqrt(area) is a fair stand-in for "how big is this face".
      radius: Math.sqrt(Math.max(area, 1e-9)),
    })
  }
  return out
}

/** Just the connected components.
 *
 *  For callers that need to address parts but not to judge them: the Edit tab
 *  redraws and re-selects shells on every step, and has no use for an issue
 *  list, a score or defect highlights until those edits are applied. Skipping
 *  the rest is most of the cost of an analysis. */
export function findShells(mesh: IndexedMesh): Shell[] {
  return findShellsAndWinding(mesh, buildAdjacency(mesh)).shells
}

export function analyseMesh(mesh: IndexedMesh, onProgress: ProgressFn = () => {}): Analysis {
  const started = performance.now()

  onProgress('Building adjacency', 0.1)
  const adj = buildAdjacency(mesh)

  onProgress('Checking edges', 0.35)
  const boundary: number[] = []
  const nonManifold: number[] = []
  for (let e = 0; e < adj.edgeCount; e++) {
    const uses = adj.edgeUseCount[e]!
    if (uses === 1) boundary.push(e)
    else if (uses > 2) nonManifold.push(e)
  }
  const boundaryEdges = Uint32Array.from(boundary)
  const nonManifoldEdges = Uint32Array.from(nonManifold)

  onProgress('Finding degenerate faces', 0.5)
  // Scale the area floor to the model so a 2 mm part and a 200 mm part are
  // judged alike. A face below this contributes nothing a slicer can use.
  const areaFloor = degenerateAreaFloor(mesh)
  const degenerate: number[] = []
  for (let t = 0; t < mesh.triangleCount; t++) {
    const a = mesh.indices[t * 3]!, b = mesh.indices[t * 3 + 1]!, c = mesh.indices[t * 3 + 2]!
    // A repeated corner index is degenerate by construction — welding
    // collapsed two corners onto the same vertex.
    if (a === b || b === c || c === a || triangleArea(mesh.positions, a, b, c) < areaFloor) {
      degenerate.push(t)
    }
  }
  const degenerateTriangles = Uint32Array.from(degenerate)

  onProgress('Tracing shells', 0.7)
  const { shells, flipped } = findShellsAndWinding(mesh, adj)

  onProgress('Writing report', 0.95)
  const watertight = boundaryEdges.length === 0 && nonManifoldEdges.length === 0
  const issues: Issue[] = []

  if (boundaryEdges.length > 0) {
    issues.push({
      kind: 'boundary',
      title: 'Not watertight',
      detail: `${boundaryEdges.length} open ${boundaryEdges.length === 1 ? 'edge' : 'edges'}. Your slicer will guess at the infill here, often badly.`,
      count: boundaryEdges.length,
      severity: 'error',
      focus: edgeCentroid(mesh, adj, boundaryEdges),
      instances: edgeInstances(mesh, adj, boundaryEdges),
      hiddenInstances: Math.max(0, boundaryEdges.length - MAX_INSTANCES),
    })
  }
  if (nonManifoldEdges.length > 0) {
    issues.push({
      kind: 'non-manifold',
      title: 'Non-manifold edges',
      detail: `${nonManifoldEdges.length} ${nonManifoldEdges.length === 1 ? 'edge is' : 'edges are'} shared by more than two faces. Your slicer may fill these in unpredictably.`,
      count: nonManifoldEdges.length,
      severity: 'error',
      focus: edgeCentroid(mesh, adj, nonManifoldEdges),
      instances: edgeInstances(mesh, adj, nonManifoldEdges),
      hiddenInstances: Math.max(0, nonManifoldEdges.length - MAX_INSTANCES),
    })
  }
  if (flipped.length > 0) {
    issues.push({
      kind: 'flipped',
      title: 'Flipped normals',
      detail: `${flipped.length} ${flipped.length === 1 ? 'face points' : 'faces point'} the wrong way — expect inverted walls.`,
      count: flipped.length,
      severity: 'error',
      focus: centroidOf(mesh, flipped),
      instances: faceInstances(mesh, flipped),
      hiddenInstances: Math.max(0, flipped.length - MAX_INSTANCES),
    })
  }
  if (degenerateTriangles.length > 0) {
    issues.push({
      kind: 'degenerate',
      title: 'Degenerate triangles',
      detail: `${degenerateTriangles.length} zero-area ${degenerateTriangles.length === 1 ? 'face' : 'faces'}. Most slicers shrug these off.`,
      count: degenerateTriangles.length,
      severity: 'note',
      focus: centroidOf(mesh, degenerateTriangles),
      instances: faceInstances(mesh, degenerateTriangles),
      hiddenInstances: Math.max(0, degenerateTriangles.length - MAX_INSTANCES),
    })
  }
  if (shells.length > 1) {
    issues.push({
      kind: 'shells',
      title: `${shells.length} separate shells`,
      detail: 'Fine if intentional — but check that none of them float off the plate.',
      count: shells.length,
      severity: 'note',
      focus: centroidOf(mesh, shells[1]!.triangles),
      instances: shells.slice(0, MAX_INSTANCES).map((shell, index) => ({
        label: `shell ${index + 1}`,
        meta: `${shell.triangles.length.toLocaleString()} tri · base z ${shell.bounds.min[2].toFixed(2)}`,
        focus: centroidOf(mesh, shell.triangles),
        radius: Math.hypot(...shell.bounds.size) / 2,
      })),
      hiddenInstances: Math.max(0, shells.length - MAX_INSTANCES),
    })
  }

  onProgress('Done', 1)
  return {
    issues,
    watertight,
    boundaryEdges,
    nonManifoldEdges,
    flippedTriangles: flipped,
    degenerateTriangles,
    shells,
    elapsedMs: performance.now() - started,
  }
}

/** Re-exported so the renderer can turn edge indices back into positions
 *  without rebuilding adjacency itself. */
export { buildAdjacency }
