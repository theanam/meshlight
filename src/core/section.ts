import type { IndexedMesh } from './types'

export const DEFAULT_BUCKETS = 200

/** Bin triangles into Z-slabs once at load time (spec §7).
 *
 *  Without this, every drag of the height slider would scan the whole mesh.
 *  A triangle spanning several slabs is listed in each one it touches, so a
 *  slice query only has to look at the single bucket containing its Z. */
export function buildZBuckets(mesh: IndexedMesh, bucketCount = DEFAULT_BUCKETS): Uint32Array[] {
  const { indices, positions, triangleCount, bounds } = mesh
  const minZ = bounds.min[2]
  const spanZ = bounds.size[2] || 1
  const staging: number[][] = Array.from({ length: bucketCount }, () => [])

  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3]!, b = indices[t * 3 + 1]!, c = indices[t * 3 + 2]!
    const z0 = positions[a * 3 + 2]!, z1 = positions[b * 3 + 2]!, z2 = positions[c * 3 + 2]!
    const lo = Math.min(z0, z1, z2)
    const hi = Math.max(z0, z1, z2)

    const first = Math.min(bucketCount - 1, Math.max(0, Math.floor(((lo - minZ) / spanZ) * bucketCount)))
    const last = Math.min(bucketCount - 1, Math.max(0, Math.floor(((hi - minZ) / spanZ) * bucketCount)))
    for (let bucket = first; bucket <= last; bucket++) staging[bucket]!.push(t)
  }

  return staging.map((list) => Uint32Array.from(list))
}

/** Intersect the mesh with a horizontal plane and return the cross-section as
 *  loose line segments: 4 floats per segment (x1, y1, x2, y2).
 *
 *  Named "section", not "slice": in 3D printing slicing means generating
 *  G-code, which Meshlight explicitly does not do (spec §2, non-goals).
 *
 *  Segments are deliberately not stitched into ordered loops — drawing them
 *  as a soup is enough for the viewer and avoids the cost and fragility of
 *  loop assembly on every slider frame. */
export function sectionAt(
  mesh: IndexedMesh,
  buckets: Uint32Array[],
  z: number,
): Float32Array {
  const { indices, positions, bounds } = mesh
  const minZ = bounds.min[2]
  const spanZ = bounds.size[2] || 1
  const bucketIndex = Math.min(
    buckets.length - 1,
    Math.max(0, Math.floor(((z - minZ) / spanZ) * buckets.length)),
  )
  const candidates = buckets[bucketIndex]
  if (!candidates) return new Float32Array(0)

  const out: number[] = []

  for (const t of candidates) {
    const v = [indices[t * 3]!, indices[t * 3 + 1]!, indices[t * 3 + 2]!]
    const crossings: number[] = []

    // Walk the three edges; each one that straddles the plane contributes a
    // point. A well-formed triangle yields exactly two.
    for (let side = 0; side < 3; side++) {
      const p = v[side]!
      const q = v[(side + 1) % 3]!
      const pz = positions[p * 3 + 2]!
      const qz = positions[q * 3 + 2]!
      if ((pz < z && qz < z) || (pz > z && qz > z)) continue
      if (pz === qz) continue // edge lies in the plane; its endpoints are caught by the other two edges

      const tt = (z - pz) / (qz - pz)
      if (tt < 0 || tt > 1) continue
      crossings.push(
        positions[p * 3]! + (positions[q * 3]! - positions[p * 3]!) * tt,
        positions[p * 3 + 1]! + (positions[q * 3 + 1]! - positions[p * 3 + 1]!) * tt,
      )
    }

    if (crossings.length >= 4) {
      out.push(crossings[0]!, crossings[1]!, crossings[2]!, crossings[3]!)
    }
  }

  return Float32Array.from(out)
}
