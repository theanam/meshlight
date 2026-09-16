/** Basic mesh editing: take a part out, resize it, turn it, slice it in two.
 *
 *  Every function here is pure — it reads an IndexedMesh and returns a new
 *  one, never mutating its input. That is what makes undo a stack of previous
 *  meshes rather than a log of inverse operations, and it is why the worker
 *  can hand the result straight to the same analyse/score path a freshly
 *  loaded file takes: an edited mesh is not a special case of anything. */

import { computeBounds, indexMesh } from './indexer'
import { earClip } from './polygon'
import type { Vec3 } from './polygon'
import type { Bounds, IndexedMesh } from './types'

export type Axis = 0 | 1 | 2

/** The plane { x : dot(normal, x) = offset }. `normal` must be unit length;
 *  "front" everywhere below means the side it points at. */
export interface CutPlane {
  normal: Vec3
  offset: number
}

export type CutKeep = 'both' | 'front' | 'back'

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function meshFrom(positions: Float32Array, indices: Uint32Array): IndexedMesh {
  return {
    positions,
    indices,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
    bounds: computeBounds(positions),
  }
}

/** Keep the triangles the predicate accepts, dropping every vertex that no
 *  surviving triangle refers to. Triangle order is preserved, so a caller
 *  that split a mesh on shell id can put the pieces back in the same order. */
export function subsetTriangles(
  mesh: IndexedMesh,
  keep: (triangle: number) => boolean,
): IndexedMesh {
  const { indices, positions, triangleCount } = mesh
  const remap = new Int32Array(mesh.vertexCount).fill(-1)
  const keptIndices: number[] = []
  const keptPositions: number[] = []

  for (let t = 0; t < triangleCount; t++) {
    if (!keep(t)) continue
    for (let corner = 0; corner < 3; corner++) {
      const v = indices[t * 3 + corner]!
      let mapped = remap[v]!
      if (mapped < 0) {
        mapped = keptPositions.length / 3
        remap[v] = mapped
        keptPositions.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!)
      }
      keptIndices.push(mapped)
    }
  }

  return meshFrom(Float32Array.from(keptPositions), Uint32Array.from(keptIndices))
}

/** Put two meshes side by side in one buffer without welding them together.
 *
 *  Deliberately not a weld: the two halves of a cut share a face exactly, and
 *  welding across would fuse them back into the single solid the cut just
 *  separated. Keeping their vertices distinct is what makes them two parts. */
export function concatMeshes(a: IndexedMesh, b: IndexedMesh): IndexedMesh {
  if (a.triangleCount === 0) return b
  if (b.triangleCount === 0) return a

  const positions = new Float32Array(a.positions.length + b.positions.length)
  positions.set(a.positions, 0)
  positions.set(b.positions, a.positions.length)

  const indices = new Uint32Array(a.indices.length + b.indices.length)
  indices.set(a.indices, 0)
  const offset = a.vertexCount
  for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i]! + offset

  return meshFrom(positions, indices)
}

/** Weld a triangle soup into an indexed mesh. */
function weld(soup: number[], epsilon: number): IndexedMesh {
  const positions = Float32Array.from(soup)
  return indexMesh(
    { positions, fileNormals: new Float32Array(0), triangleCount: soup.length / 9, format: '' },
    epsilon,
  )
}

/** Extents of the vertices the given triangles use. */
function boundsOfTriangles(mesh: IndexedMesh, member: Uint8Array): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  let found = false

  for (let t = 0; t < mesh.triangleCount; t++) {
    if (!member[t]) continue
    found = true
    for (let corner = 0; corner < 3; corner++) {
      const v = mesh.indices[t * 3 + corner]!
      for (let axis = 0; axis < 3; axis++) {
        const value = mesh.positions[v * 3 + axis]!
        if (value < min[axis]!) min[axis] = value
        if (value > max[axis]!) max[axis] = value
      }
    }
  }
  if (!found) return mesh.bounds

  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  }
}

/** One byte per triangle: is it in the selection? A null shell means all of
 *  them, which is how "no part selected" reaches every operation here. */
function membership(shellIds: Uint32Array, shell: number | null, triangleCount: number): Uint8Array {
  const member = new Uint8Array(triangleCount)
  for (let t = 0; t < triangleCount; t++) {
    member[t] = shell === null || shellIds[t] === shell ? 1 : 0
  }
  return member
}

// ---------------------------------------------------------------------------
// Delete and extract
// ---------------------------------------------------------------------------

/** Everything except the named part. */
export function deleteShell(
  mesh: IndexedMesh,
  shellIds: Uint32Array,
  shell: number,
): IndexedMesh {
  return subsetTriangles(mesh, (t) => shellIds[t] !== shell)
}

/** Just the named part, on its own. */
export function extractShell(
  mesh: IndexedMesh,
  shellIds: Uint32Array,
  shell: number,
): IndexedMesh {
  return subsetTriangles(mesh, (t) => shellIds[t] === shell)
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/** Move the selection's vertices through `move`, leaving the rest where they
 *  are.
 *
 *  Welding can leave two shells sharing a vertex where they touch at a point.
 *  Dragging that vertex would drag both, so any vertex the selection shares
 *  with the outside world is duplicated first and the selection re-pointed at
 *  the copy. Triangle order never changes, which keeps shell indices — and so
 *  the current selection — valid across the edit. */
function transformPart(
  mesh: IndexedMesh,
  shellIds: Uint32Array,
  shell: number | null,
  move: (v: Vec3, pivot: Vec3) => Vec3,
): IndexedMesh {
  const member = membership(shellIds, shell, mesh.triangleCount)
  const pivot = boundsOfTriangles(mesh, member).center

  const usedBySelection = new Uint8Array(mesh.vertexCount)
  const usedByRest = new Uint8Array(mesh.vertexCount)
  for (let t = 0; t < mesh.triangleCount; t++) {
    const target = member[t] ? usedBySelection : usedByRest
    for (let corner = 0; corner < 3; corner++) target[mesh.indices[t * 3 + corner]!] = 1
  }

  const positions = Array.from(mesh.positions)
  const indices = Uint32Array.from(mesh.indices)
  const duplicate = new Int32Array(mesh.vertexCount).fill(-1)
  const moving: number[] = []

  for (let v = 0; v < mesh.vertexCount; v++) {
    if (!usedBySelection[v]) continue
    if (usedByRest[v]) {
      duplicate[v] = positions.length / 3
      positions.push(mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!)
      moving.push(duplicate[v]!)
    } else {
      moving.push(v)
    }
  }

  for (let t = 0; t < mesh.triangleCount; t++) {
    if (!member[t]) continue
    for (let corner = 0; corner < 3; corner++) {
      const slot = t * 3 + corner
      const copy = duplicate[indices[slot]!]!
      if (copy >= 0) indices[slot] = copy
    }
  }

  for (const v of moving) {
    const moved = move([positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!], pivot)
    positions[v * 3] = moved[0]
    positions[v * 3 + 1] = moved[1]
    positions[v * 3 + 2] = moved[2]
  }

  return meshFrom(Float32Array.from(positions), indices)
}

/** Resize about the selection's own centre, so a part grows in place rather
 *  than sliding away from the origin as it scales. */
export function scalePart(
  mesh: IndexedMesh,
  shellIds: Uint32Array,
  shell: number | null,
  factor: [number, number, number],
): IndexedMesh {
  return transformPart(mesh, shellIds, shell, (v, pivot) => [
    pivot[0] + (v[0] - pivot[0]) * factor[0],
    pivot[1] + (v[1] - pivot[1]) * factor[1],
    pivot[2] + (v[2] - pivot[2]) * factor[2],
  ])
}

/** Turn about the selection's centre, around a world axis.
 *
 *  A mirror would need the winding reversed to stay solid; a rotation is
 *  rigid, so the faces that were facing out still are. */
export function rotatePart(
  mesh: IndexedMesh,
  shellIds: Uint32Array,
  shell: number | null,
  axis: Axis,
  degrees: number,
): IndexedMesh {
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  // The two axes that actually move; the axis being turned about holds still.
  const i = ((axis + 1) % 3) as Axis
  const j = ((axis + 2) % 3) as Axis

  return transformPart(mesh, shellIds, shell, (v, pivot) => {
    const a = v[i] - pivot[i]
    const b = v[j] - pivot[j]
    const out: Vec3 = [v[0], v[1], v[2]]
    out[i] = pivot[i] + a * cos - b * sin
    out[j] = pivot[j] + a * sin + b * cos
    return out
  })
}

// ---------------------------------------------------------------------------
// Cutting
// ---------------------------------------------------------------------------

export interface CutResult {
  mesh: IndexedMesh
  /** Triangles the plane passed through and had to split. Zero means the
   *  line missed, and the caller should say so rather than claim a cut. */
  splitTriangles: number
  /** Triangles added to close the faces the cut opened. */
  capTriangles: number
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

function pushTriangle(soup: number[], a: Vec3, b: Vec3, c: Vec3): void {
  soup.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
}

/** Clip one triangle to the half-space we are keeping, and report the edge
 *  the plane carved across it.
 *
 *  Sutherland–Hodgman on three edges yields a triangle or a quad, which is
 *  fanned. Exactly two of the output points are new, and the polygon edge
 *  joining them is the boundary of the hole the cut opened — returned so the
 *  caller can chain those edges into loops and cap them. */
function clipTriangle(
  corners: [Vec3, Vec3, Vec3],
  distances: [number, number, number],
  sign: 1 | -1,
  soup: number[],
): [Vec3, Vec3] | null {
  const poly: Vec3[] = []
  const fresh: number[] = []

  for (let i = 0; i < 3; i++) {
    const a = corners[i]!
    const b = corners[(i + 1) % 3]!
    const da = distances[i]! * sign
    const db = distances[(i + 1) % 3]! * sign

    if (da >= 0) poly.push(a)
    if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
      fresh.push(poly.length)
      poly.push(lerp(a, b, da / (da - db)))
    }
  }

  for (let i = 1; i + 1 < poly.length; i++) {
    pushTriangle(soup, poly[0]!, poly[i]!, poly[i + 1]!)
  }

  if (fresh.length !== 2) return null
  const [first, second] = fresh as [number, number]
  // The two new points bound the hole. They are adjacent in the polygon
  // either directly or around the wrap, and the direction is the polygon's
  // own winding, which is what makes the chained loops consistent.
  if (second === first + 1) return [poly[first]!, poly[second]!]
  if (first === 0 && second === poly.length - 1) return [poly[second]!, poly[first]!]
  return null
}

/** Chain cut edges into closed loops, matching endpoints by position. */
function capLoops(edges: [Vec3, Vec3][], epsilon: number): Vec3[][] {
  const key = (p: Vec3): string =>
    `${Math.round(p[0] / epsilon)},${Math.round(p[1] / epsilon)},${Math.round(p[2] / epsilon)}`

  const next = new Map<string, { to: Vec3; toKey: string }[]>()
  for (const [from, to] of edges) {
    const fromKey = key(from)
    const entry = { to, toKey: key(to) }
    const list = next.get(fromKey)
    if (list) list.push(entry)
    else next.set(fromKey, [entry])
  }

  const loops: Vec3[][] = []
  const guard = edges.length + 1

  while (next.size > 0) {
    const startKey = next.keys().next().value as string
    const loop: Vec3[] = []
    let currentKey = startKey

    for (let step = 0; step < guard; step++) {
      const options = next.get(currentKey)
      if (!options || options.length === 0) break
      const hop = options.pop()!
      if (options.length === 0) next.delete(currentKey)
      loop.push(hop.to)
      currentKey = hop.toKey
      if (currentKey === startKey) break
    }

    // A loop that never came back to its start is an open chain — the plane
    // grazed a boundary. Dropping it leaves a hole the Report will flag and
    // Fix can close, which beats capping it with a fold.
    if (loop.length >= 3 && currentKey === startKey) loops.push(loop)
  }

  return loops
}

/** Close each loop with triangles facing `facing`. */
function capTriangles(loops: Vec3[][], facing: Vec3, soup: number[]): number {
  let added = 0

  for (const loop of loops) {
    const flat = new Float32Array(loop.length * 3)
    loop.forEach((p, i) => {
      flat[i * 3] = p[0]
      flat[i * 3 + 1] = p[1]
      flat[i * 3 + 2] = p[2]
    })

    const indices = loop.map((_, i) => i)
    const fan =
      earClip(flat, indices) ??
      // Twisted loop: fan from the centroid instead. It adds a vertex the
      // wall does not have, but it always closes.
      (() => {
        const cx = loop.reduce((sum, p) => sum + p[0], 0) / loop.length
        const cy = loop.reduce((sum, p) => sum + p[1], 0) / loop.length
        const cz = loop.reduce((sum, p) => sum + p[2], 0) / loop.length
        const centre = loop.length
        loop.push([cx, cy, cz])
        return indices.map((current, i) => [current, indices[(i + 1) % indices.length]!, centre])
      })()

    for (const tri of fan) {
      const a = loop[tri[0]!]!
      const b = loop[tri[1]!]!
      const c = loop[tri[2]!]!
      // Ear clipping winds to the loop's own normal, which may be either way
      // round. Measure the triangle and flip it if it faces the wrong way, so
      // the cap agrees with the walls it closes.
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
      const nx = uy * vz - uz * vy
      const ny = uz * vx - ux * vz
      const nz = ux * vy - uy * vx
      const facingAway = nx * facing[0] + ny * facing[1] + nz * facing[2] < 0
      if (facingAway) pushTriangle(soup, a, c, b)
      else pushTriangle(soup, a, b, c)
      added++
    }
  }

  return added
}

/** Slide the plane off any vertex it lands exactly on.
 *
 *  A plane through a vertex is the one case this algorithm cannot express.
 *  Clipping finds the cut edge by looking at where triangles straddle, and a
 *  plane running along a model's own edge straddles nothing there — so that
 *  stretch of the boundary never gets recorded, the cap loop cannot close,
 *  and the "cut" leaves a hole. It is not a rare case either: cut an
 *  axis-aligned box corner to corner and the plane lies along two of its
 *  edges.
 *
 *  Rather than special-case coplanar geometry, move the plane a few microns
 *  until it passes through nothing but triangle interiors. The shift is
 *  scaled to the model and lands far below any printer's resolution — on a
 *  100 mm part it is under three microns — and in exchange every cut is an
 *  ordinary transversal one. */
function clearOfVertices(
  mesh: IndexedMesh,
  normal: Vec3,
  offset: number,
  tolerance: number,
): number {
  const { positions, vertexCount } = mesh

  for (let attempt = 0; attempt <= 8; attempt++) {
    const shifted = offset + attempt * tolerance * 4
    let closest = Infinity

    for (let v = 0; v < vertexCount; v++) {
      const d = Math.abs(
        positions[v * 3]! * normal[0] +
          positions[v * 3 + 1]! * normal[1] +
          positions[v * 3 + 2]! * normal[2] -
          shifted,
      )
      if (d < closest) closest = d
      if (closest <= tolerance) break
    }

    if (closest > tolerance) return shifted
  }

  // Every offset tried still grazes something — vertices that dense are a
  // mesh problem, not a cut problem. Take the last one and let the Report
  // flag whatever hole comes out.
  return offset + 8 * tolerance * 4
}

/** Split a mesh on a plane and close both new faces.
 *
 *  The two halves are welded separately and then placed in one buffer without
 *  welding across, so they stay two parts you can select, export or delete
 *  independently rather than one solid with an internal wall. */
export function cutMesh(
  mesh: IndexedMesh,
  plane: CutPlane,
  keep: CutKeep,
  weldEpsilon: number,
): CutResult {
  const { normal } = plane
  const { indices, positions, triangleCount } = mesh
  const extent = Math.max(...mesh.bounds.size, 1)
  // Points nearer the plane than this count as on it. Scaled to the model so
  // the same cut behaves the same on a 5 mm part and a 500 mm one.
  const onPlane = extent * 1e-6
  const offset = clearOfVertices(mesh, normal, plane.offset, onPlane)

  const front: number[] = []
  const back: number[] = []
  const cutEdges: [Vec3, Vec3][] = []
  let splitTriangles = 0

  for (let t = 0; t < triangleCount; t++) {
    const corners: [Vec3, Vec3, Vec3] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    const distances: [number, number, number] = [0, 0, 0]

    for (let corner = 0; corner < 3; corner++) {
      const v = indices[t * 3 + corner]!
      const p: Vec3 = [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!]
      corners[corner] = p
      distances[corner] = p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2] - offset
    }

    const above = distances.some((d) => d > onPlane)
    const below = distances.some((d) => d < -onPlane)

    if (!below) {
      pushTriangle(front, corners[0], corners[1], corners[2])
      continue
    }
    if (!above) {
      pushTriangle(back, corners[0], corners[1], corners[2])
      continue
    }

    splitTriangles++
    const edge = clipTriangle(corners, distances, 1, front)
    clipTriangle(corners, distances, -1, back)
    if (edge) cutEdges.push(edge)
  }

  // The cut face is one surface seen from two sides: cap it once and give
  // each half its own copy, wound to face out of that half.
  const loops = capLoops(cutEdges, weldEpsilon)
  const negated: Vec3 = [-normal[0], -normal[1], -normal[2]]
  let capCount = 0
  if (keep !== 'back') capCount += capTriangles(loops, negated, front)
  if (keep !== 'front') capCount += capTriangles(loops, normal, back)

  const frontMesh = front.length > 0 ? weld(front, weldEpsilon) : null
  const backMesh = back.length > 0 ? weld(back, weldEpsilon) : null

  const pieces =
    keep === 'front' ? [frontMesh] : keep === 'back' ? [backMesh] : [frontMesh, backMesh]
  const kept = pieces.filter((piece): piece is IndexedMesh => piece !== null)

  return {
    mesh: kept.length === 0 ? mesh : kept.reduce(concatMeshes),
    splitTriangles,
    capTriangles: capCount,
  }
}

/** Cut, but only through the selected part — everything else is left alone. */
export function cutPart(
  mesh: IndexedMesh,
  shellIds: Uint32Array,
  shell: number | null,
  plane: CutPlane,
  keep: CutKeep,
  weldEpsilon: number,
): CutResult {
  if (shell === null) return cutMesh(mesh, plane, keep, weldEpsilon)

  const target = extractShell(mesh, shellIds, shell)
  const rest = deleteShell(mesh, shellIds, shell)
  const result = cutMesh(target, plane, keep, weldEpsilon)

  return { ...result, mesh: concatMeshes(result.mesh, rest) }
}
