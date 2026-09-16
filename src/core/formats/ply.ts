import { MeshParseError, SoupBuilder } from './errors'
import type { RawMesh } from '../types'

type Scalar =
  | 'char' | 'uchar' | 'short' | 'ushort' | 'int' | 'uint' | 'float' | 'double'

/** PLY spells the same types several ways depending on the exporter. */
const SCALARS: Record<string, Scalar> = {
  char: 'char', int8: 'char',
  uchar: 'uchar', uint8: 'uchar',
  short: 'short', int16: 'short',
  ushort: 'ushort', uint16: 'ushort',
  int: 'int', int32: 'int',
  uint: 'uint', uint32: 'uint',
  float: 'float', float32: 'float',
  double: 'double', float64: 'double',
}

const SIZES: Record<Scalar, number> = {
  char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8,
}

interface Property {
  name: string
  /** Set for list properties: the type of the leading count. */
  countType?: Scalar
  valueType: Scalar
}

interface Element {
  name: string
  count: number
  properties: Property[]
}

/** Stanford PLY, ascii and both binary byte orders.
 *
 *  Common output from 3D scanners and photogrammetry, which is exactly the
 *  kind of mesh that arrives full of holes and loose shells. */
export function parsePly(buffer: ArrayBuffer): RawMesh {
  const bytes = new Uint8Array(buffer)

  // The header is always ascii, however the body is encoded, so decode just
  // enough to find end_header rather than the whole file.
  const probe = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 65_536)))
  const headerEnd = probe.indexOf('end_header')
  if (!probe.startsWith('ply') || headerEnd === -1) {
    throw new MeshParseError('This does not look like a PLY file.')
  }
  const afterKeyword = headerEnd + 'end_header'.length
  const newline = probe.indexOf('\n', afterKeyword)
  const bodyStart = newline === -1 ? afterKeyword : newline + 1

  let encoding: 'ascii' | 'little' | 'big' = 'ascii'
  const elements: Element[] = []

  for (const rawLine of probe.slice(0, headerEnd).split('\n')) {
    const parts = rawLine.trim().split(/\s+/)
    const keyword = parts[0]

    if (keyword === 'format') {
      const mode = parts[1]
      if (mode === 'ascii') encoding = 'ascii'
      else if (mode === 'binary_little_endian') encoding = 'little'
      else if (mode === 'binary_big_endian') encoding = 'big'
      else throw new MeshParseError(`Unsupported PLY encoding "${mode ?? '?'}".`)
    } else if (keyword === 'element') {
      elements.push({ name: parts[1] ?? '', count: Number(parts[2] ?? 0), properties: [] })
    } else if (keyword === 'property') {
      const element = elements[elements.length - 1]
      if (!element) continue
      if (parts[1] === 'list') {
        const countType = SCALARS[parts[2] ?? '']
        const valueType = SCALARS[parts[3] ?? '']
        if (!countType || !valueType) continue
        element.properties.push({ name: parts[4] ?? '', countType, valueType })
      } else {
        const valueType = SCALARS[parts[1] ?? '']
        if (!valueType) continue
        element.properties.push({ name: parts[2] ?? '', valueType })
      }
    }
  }

  const vertexElement = elements.find((e) => e.name === 'vertex')
  const faceElement = elements.find((e) => e.name === 'face')
  if (!vertexElement) throw new MeshParseError('This PLY declares no vertices.')

  const vertices = new Float32Array(vertexElement.count * 3)
  const soup = new SoupBuilder()

  const xIndex = vertexElement.properties.findIndex((p) => p.name === 'x')
  const yIndex = vertexElement.properties.findIndex((p) => p.name === 'y')
  const zIndex = vertexElement.properties.findIndex((p) => p.name === 'z')
  if (xIndex === -1 || yIndex === -1 || zIndex === -1) {
    throw new MeshParseError('This PLY has no x/y/z vertex positions.')
  }

  const addFace = (indices: number[]): void => {
    const corners: number[] = []
    for (const index of indices) {
      if (index < 0 || index >= vertexElement.count) return
      corners.push(vertices[index * 3]!, vertices[index * 3 + 1]!, vertices[index * 3 + 2]!)
    }
    if (corners.length >= 9) soup.polygon(corners)
  }

  if (encoding === 'ascii') {
    const body = new TextDecoder().decode(bytes.subarray(bodyStart))
    // Read value-by-value: PLY does not promise one element per line.
    const tokens = body.split(/\s+/).filter((t) => t.length > 0)
    let cursor = 0
    const take = (): number => Number(tokens[cursor++] ?? NaN)

    for (const element of elements) {
      for (let i = 0; i < element.count; i++) {
        if (element === vertexElement) {
          const values: number[] = []
          for (const property of element.properties) {
            if (property.countType) {
              const n = take()
              for (let k = 0; k < n; k++) take()
              values.push(NaN)
            } else values.push(take())
          }
          vertices[i * 3] = values[xIndex]!
          vertices[i * 3 + 1] = values[yIndex]!
          vertices[i * 3 + 2] = values[zIndex]!
        } else if (element === faceElement) {
          let face: number[] = []
          for (const property of element.properties) {
            if (property.countType) {
              const n = take()
              const list: number[] = []
              for (let k = 0; k < n; k++) list.push(take())
              if (property.name.includes('ind')) face = list
            } else take()
          }
          addFace(face)
        } else {
          for (const property of element.properties) {
            if (property.countType) {
              const n = take()
              for (let k = 0; k < n; k++) take()
            } else take()
          }
        }
      }
    }
  } else {
    const view = new DataView(buffer)
    const little = encoding === 'little'
    let offset = bodyStart

    const read = (type: Scalar): number => {
      let value: number
      switch (type) {
        case 'char': value = view.getInt8(offset); break
        case 'uchar': value = view.getUint8(offset); break
        case 'short': value = view.getInt16(offset, little); break
        case 'ushort': value = view.getUint16(offset, little); break
        case 'int': value = view.getInt32(offset, little); break
        case 'uint': value = view.getUint32(offset, little); break
        case 'float': value = view.getFloat32(offset, little); break
        case 'double': value = view.getFloat64(offset, little); break
      }
      offset += SIZES[type]
      return value
    }

    for (const element of elements) {
      for (let i = 0; i < element.count; i++) {
        if (offset >= buffer.byteLength) {
          throw new MeshParseError('This PLY ends before the data it declares.')
        }
        if (element === vertexElement) {
          const values: number[] = []
          for (const property of element.properties) {
            if (property.countType) {
              const n = read(property.countType)
              for (let k = 0; k < n; k++) read(property.valueType)
              values.push(NaN)
            } else values.push(read(property.valueType))
          }
          vertices[i * 3] = values[xIndex]!
          vertices[i * 3 + 1] = values[yIndex]!
          vertices[i * 3 + 2] = values[zIndex]!
        } else if (element === faceElement) {
          let face: number[] = []
          for (const property of element.properties) {
            if (property.countType) {
              const n = read(property.countType)
              const list: number[] = []
              for (let k = 0; k < n; k++) list.push(read(property.valueType))
              if (property.name.includes('ind')) face = list
            } else read(property.valueType)
          }
          addFace(face)
        } else {
          for (const property of element.properties) {
            if (property.countType) {
              const n = read(property.countType)
              for (let k = 0; k < n; k++) read(property.valueType)
            } else read(property.valueType)
          }
        }
      }
    }
  }

  if (soup.triangleCount === 0) {
    throw new MeshParseError('This PLY has vertices but no faces, so there is no surface to check.')
  }

  return {
    positions: soup.positions(),
    fileNormals: new Float32Array(soup.triangleCount * 3),
    triangleCount: soup.triangleCount,
    format: encoding === 'ascii' ? 'PLY (ascii)' : 'PLY (binary)',
  }
}
