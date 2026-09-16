import type { Adjacency, IndexedMesh } from './types'

export const NO_TRIANGLE = 0xffffffff

/** Build the edge map once and reuse it everywhere (spec §7).
 *
 *  Manifold checking, watertightness, winding consistency and shell
 *  flood-fill are all questions about the same edge->triangle relation, so
 *  this runs a single time per mesh and every later stage reads from it. */
export function buildAdjacency(mesh: IndexedMesh): Adjacency {
  const { indices, triangleCount, vertexCount } = mesh

  // Numeric key beats a string key by a wide margin here. vertexCount stays
  // well under 2^26 for any mesh we target, so lo * vertexCount + hi is exact
  // in a double.
  const lookup = new Map<number, number>()
  const maxEdges = triangleCount * 3
  const edges = new Uint32Array(maxEdges * 2)
  const edgeUseCount = new Uint8Array(maxEdges)
  const edgeTriangles = new Uint32Array(maxEdges * 2).fill(NO_TRIANGLE)
  const triEdges = new Uint32Array(triangleCount * 3)
  let edgeCount = 0

  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3]!, b = indices[t * 3 + 1]!, c = indices[t * 3 + 2]!
    const corners: [number, number][] = [[a, b], [b, c], [c, a]]

    for (let side = 0; side < 3; side++) {
      const [u, v] = corners[side]!
      const lo = u < v ? u : v
      const hi = u < v ? v : u
      const key = lo * vertexCount + hi

      let edge = lookup.get(key)
      if (edge === undefined) {
        edge = edgeCount++
        lookup.set(key, edge)
        edges[edge * 2] = lo
        edges[edge * 2 + 1] = hi
      }

      triEdges[t * 3 + side] = edge
      // Saturate rather than wrap: a count of 255 still reads as non-manifold.
      if (edgeUseCount[edge]! < 255) edgeUseCount[edge]!++
      if (edgeTriangles[edge * 2] === NO_TRIANGLE) edgeTriangles[edge * 2] = t
      else if (edgeTriangles[edge * 2 + 1] === NO_TRIANGLE) edgeTriangles[edge * 2 + 1] = t
    }
  }

  return {
    edges: edges.slice(0, edgeCount * 2),
    edgeUseCount: edgeUseCount.slice(0, edgeCount),
    edgeTriangles: edgeTriangles.slice(0, edgeCount * 2),
    triEdges,
    edgeCount,
  }
}

/** True when triangle `t` walks the edge from `lo` to `hi`.
 *  Two correctly-wound neighbours always traverse their shared edge in
 *  opposite directions, which is the whole basis of the winding check. */
export function traversesForward(
  indices: Uint32Array,
  t: number,
  lo: number,
  hi: number,
): boolean {
  const a = indices[t * 3]!, b = indices[t * 3 + 1]!, c = indices[t * 3 + 2]!
  return (a === lo && b === hi) || (b === lo && c === hi) || (c === lo && a === hi)
}
