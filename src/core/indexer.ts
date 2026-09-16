import type { Bounds, IndexedMesh, RawMesh } from './types'

export function computeBounds(positions: Float32Array, count = positions.length / 3): Bounds {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  if (!Number.isFinite(minX)) {
    minX = minY = minZ = maxX = maxY = maxZ = 0
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
  }
}

/** Merge duplicate vertices so topology can be reasoned about at all.
 *
 *  STL stores a triangle soup with no shared vertices, so before any manifold
 *  or shell question can be asked the corners have to be welded back together
 *  (spec §5.3: "build an indexed mesh as the first processing step").
 *
 *  Welding snaps coordinates onto an epsilon grid and hashes the resulting
 *  integer cell. Exact float equality would miss vertices that differ in the
 *  last bit, which is the common case in exported STLs. */
export function indexMesh(raw: RawMesh, epsilon: number): IndexedMesh {
  const { positions: soup, triangleCount } = raw
  const inverse = 1 / epsilon

  const lookup = new Map<string, number>()
  // Upper bound is one unique vertex per corner; trimmed once the real count
  // is known, so we allocate once instead of growing an array of numbers.
  const unique = new Float32Array(triangleCount * 9)
  const indices = new Uint32Array(triangleCount * 3)
  let vertexCount = 0

  for (let corner = 0; corner < triangleCount * 3; corner++) {
    const x = soup[corner * 3]!, y = soup[corner * 3 + 1]!, z = soup[corner * 3 + 2]!
    // Math.round, not truncation, so points either side of a cell boundary
    // land in the same cell as often as possible.
    const key = `${Math.round(x * inverse)},${Math.round(y * inverse)},${Math.round(z * inverse)}`
    let index = lookup.get(key)
    if (index === undefined) {
      index = vertexCount++
      lookup.set(key, index)
      unique[index * 3 + 0] = x
      unique[index * 3 + 1] = y
      unique[index * 3 + 2] = z
    }
    indices[corner] = index
  }

  const positions = unique.slice(0, vertexCount * 3)
  return {
    positions,
    indices,
    vertexCount,
    triangleCount,
    bounds: computeBounds(positions, vertexCount),
  }
}
