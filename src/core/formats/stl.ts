import { MeshParseError } from './errors'
import type { RawMesh } from '../types'

const BINARY_HEADER_BYTES = 84
const BINARY_TRIANGLE_BYTES = 50

/** Binary and ASCII STL share the .stl extension and the word "solid", so
 *  sniff by size arithmetic rather than by the leading keyword: a binary file
 *  is exactly 84 + 50n bytes. Some exporters write "solid" into the binary
 *  header, which is why the keyword alone is not trustworthy. */
function isBinary(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < BINARY_HEADER_BYTES) return false
  const view = new DataView(buffer)
  const declared = view.getUint32(80, true)
  return buffer.byteLength === BINARY_HEADER_BYTES + declared * BINARY_TRIANGLE_BYTES
}

function parseBinary(buffer: ArrayBuffer): RawMesh {
  const view = new DataView(buffer)
  const triangleCount = view.getUint32(80, true)
  if (triangleCount === 0) throw new MeshParseError('This STL declares zero triangles.')

  const positions = new Float32Array(triangleCount * 9)
  const fileNormals = new Float32Array(triangleCount * 3)

  let offset = BINARY_HEADER_BYTES
  for (let t = 0; t < triangleCount; t++) {
    fileNormals[t * 3 + 0] = view.getFloat32(offset + 0, true)
    fileNormals[t * 3 + 1] = view.getFloat32(offset + 4, true)
    fileNormals[t * 3 + 2] = view.getFloat32(offset + 8, true)
    for (let corner = 0; corner < 3; corner++) {
      const src = offset + 12 + corner * 12
      const dst = t * 9 + corner * 3
      positions[dst + 0] = view.getFloat32(src + 0, true)
      positions[dst + 1] = view.getFloat32(src + 4, true)
      positions[dst + 2] = view.getFloat32(src + 8, true)
    }
    offset += BINARY_TRIANGLE_BYTES
  }

  return { positions, fileNormals, triangleCount, format: 'STL (binary)' }
}

function parseAscii(buffer: ArrayBuffer): RawMesh {
  const text = new TextDecoder().decode(buffer)
  // Grow-able staging arrays: ASCII STL gives no triangle count up front.
  const positions: number[] = []
  const fileNormals: number[] = []

  const facetRe = /facet\s+normal\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)([\s\S]*?)endfacet/g
  const vertexRe = /vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g

  let facet: RegExpExecArray | null
  while ((facet = facetRe.exec(text)) !== null) {
    const body = facet[4] ?? ''
    const corners: number[] = []
    vertexRe.lastIndex = 0
    let vertex: RegExpExecArray | null
    while ((vertex = vertexRe.exec(body)) !== null) {
      corners.push(Number(vertex[1]), Number(vertex[2]), Number(vertex[3]))
    }
    // Skip malformed facets rather than failing the whole file — a single bad
    // facet in an otherwise good export should not cost the user the model.
    if (corners.length !== 9) continue
    if (corners.some((n) => !Number.isFinite(n))) continue

    fileNormals.push(Number(facet[1]), Number(facet[2]), Number(facet[3]))
    positions.push(...corners)
  }

  const triangleCount = positions.length / 9
  if (triangleCount === 0) {
    throw new MeshParseError('No triangles found — this does not look like an STL file.')
  }

  return {
    positions: new Float32Array(positions),
    fileNormals: new Float32Array(fileNormals),
    triangleCount,
    format: 'STL (ascii)',
  }
}

export function parseStl(buffer: ArrayBuffer): RawMesh {
  if (buffer.byteLength === 0) throw new MeshParseError('That file is empty.')
  if (buffer.byteLength < 15) throw new MeshParseError('That file is too small to be an STL.')
  return isBinary(buffer) ? parseBinary(buffer) : parseAscii(buffer)
}
