import { MeshParseError, SoupBuilder } from './errors'
import type { RawMesh } from '../types'

/** Wavefront OBJ.
 *
 *  Only geometry is read: `v` for positions and `f` for faces. Normals,
 *  texture coordinates, materials, groups and smoothing are all ignored —
 *  none of them affect whether a mesh is printable, and OBJ's own normals are
 *  no more trustworthy than STL's. */
export function parseObj(buffer: ArrayBuffer): RawMesh {
  const text = new TextDecoder().decode(buffer)
  const soup = new SoupBuilder()
  const vertices: number[] = []

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue

    // Split on the keyword only; the rest is handled per directive.
    const space = line.indexOf(' ')
    if (space === -1) continue
    const keyword = line.slice(0, space)
    const body = line.slice(space + 1).trim()

    if (keyword === 'v') {
      const parts = body.split(/\s+/)
      const x = Number(parts[0]), y = Number(parts[1]), z = Number(parts[2])
      // A `v` may carry a trailing weight and, in some exporters, vertex
      // colours; only the first three values are position.
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      vertices.push(x, y, z)
      continue
    }

    if (keyword !== 'f') continue

    const corners: number[] = []
    for (const token of body.split(/\s+/)) {
      // Each corner is v, v/vt, v//vn or v/vt/vn — only the first matters.
      const slash = token.indexOf('/')
      const raw = Number(slash === -1 ? token : token.slice(0, slash))
      if (!Number.isFinite(raw) || raw === 0) continue
      // OBJ indices are 1-based; negative counts back from the most recently
      // defined vertex, which exporters use for streaming output.
      const index = raw > 0 ? raw - 1 : vertices.length / 3 + raw
      if (index < 0 || index * 3 + 2 >= vertices.length) continue
      corners.push(vertices[index * 3]!, vertices[index * 3 + 1]!, vertices[index * 3 + 2]!)
    }

    if (corners.length >= 9) soup.polygon(corners)
  }

  if (soup.triangleCount === 0) {
    throw new MeshParseError(
      vertices.length === 0
        ? 'No vertices found — this does not look like an OBJ file.'
        : 'This OBJ has vertices but no faces, so there is no surface to check.',
    )
  }

  return {
    positions: soup.positions(),
    // OBJ carries no per-face normals worth keeping; winding decides.
    fileNormals: new Float32Array(soup.triangleCount * 3),
    triangleCount: soup.triangleCount,
    format: 'OBJ',
  }
}
