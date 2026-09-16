import { MeshParseError, SoupBuilder } from './errors'
import { readZipEntry } from './zip'
import type { RawMesh } from '../types'

/** 3MF states its own units; Meshlight works in millimetres throughout. */
const UNIT_TO_MM: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
}

/** Row-major 4x3 as 3MF writes it, applied as row-vector × matrix. */
type Matrix = readonly number[]

const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Array<number>(12).fill(0)
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3]! * b[col]! + a[row * 3 + 1]! * b[3 + col]! + a[row * 3 + 2]! * b[6 + col]!
    }
  }
  for (let col = 0; col < 3; col++) {
    out[9 + col] =
      a[9]! * b[col]! + a[10]! * b[3 + col]! + a[11]! * b[6 + col]! + b[9 + col]!
  }
  return out
}

function apply(m: Matrix, x: number, y: number, z: number): [number, number, number] {
  return [
    x * m[0]! + y * m[3]! + z * m[6]! + m[9]!,
    x * m[1]! + y * m[4]! + z * m[7]! + m[10]!,
    x * m[2]! + y * m[5]! + z * m[8]! + m[11]!,
  ]
}

function parseMatrix(value: string | undefined): Matrix {
  if (!value) return IDENTITY
  const n = value.trim().split(/\s+/).map(Number)
  return n.length === 12 && n.every(Number.isFinite) ? n : IDENTITY
}

/** Pull the attributes off every occurrence of one tag.
 *
 *  DOMParser does not exist in a Web Worker, and 3MF's model XML is
 *  machine-generated and flat, so a tag scanner is enough. It reads
 *  attributes only — no namespaces, no entity decoding — which is fine
 *  because everything we need is a number or an id. */
function* tags(xml: string, name: string): Generator<Record<string, string>> {
  const re = new RegExp(`<${name}\\b([^>]*)>`, 'g')
  const attr = /([\w:.-]+)\s*=\s*"([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml)) !== null) {
    const out: Record<string, string> = {}
    attr.lastIndex = 0
    let a: RegExpExecArray | null
    while ((a = attr.exec(match[1] ?? '')) !== null) out[a[1]!] = a[2]!
    yield out
  }
}

interface ObjectDef {
  vertices: number[]
  triangles: number[]
  components: { objectid: string; transform: Matrix }[]
}

export async function parse3mf(buffer: ArrayBuffer): Promise<RawMesh> {
  const entry = await readZipEntry(buffer, (name) => /3dmodel\.model$/i.test(name))
  if (!entry) throw new MeshParseError('No 3D model found inside this 3MF file.')
  const xml = new TextDecoder().decode(entry.data)

  const model = tags(xml, 'model').next().value as Record<string, string> | undefined
  const scale = UNIT_TO_MM[model?.unit ?? 'millimeter'] ?? 1

  // Split on object boundaries so each object's vertices and triangles are
  // read from its own block rather than the whole document.
  const objects = new Map<string, ObjectDef>()
  const objectRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g
  let match: RegExpExecArray | null
  while ((match = objectRe.exec(xml)) !== null) {
    const header = match[1] ?? ''
    const body = match[2] ?? ''
    const id = /\bid\s*=\s*"([^"]*)"/.exec(header)?.[1]
    if (!id) continue

    const def: ObjectDef = { vertices: [], triangles: [], components: [] }
    for (const v of tags(body, 'vertex')) {
      def.vertices.push(Number(v.x) * scale, Number(v.y) * scale, Number(v.z) * scale)
    }
    for (const t of tags(body, 'triangle')) {
      def.triangles.push(Number(t.v1), Number(t.v2), Number(t.v3))
    }
    for (const c of tags(body, 'component')) {
      if (c.objectid) def.components.push({ objectid: c.objectid, transform: parseMatrix(c.transform) })
    }
    objects.set(id, def)
  }

  if (objects.size === 0) throw new MeshParseError('This 3MF contains no objects.')

  const soup = new SoupBuilder()
  const emit = (id: string, transform: Matrix, depth: number): void => {
    // Components can nest, and a malformed file could make them cycle.
    if (depth > 16) return
    const def = objects.get(id)
    if (!def) return

    for (let t = 0; t + 2 < def.triangles.length; t += 3) {
      const corners: number[] = []
      for (let k = 0; k < 3; k++) {
        const index = def.triangles[t + k]!
        if (!Number.isFinite(index) || index < 0 || index * 3 + 2 >= def.vertices.length) {
          corners.length = 0
          break
        }
        const [x, y, z] = apply(
          transform,
          def.vertices[index * 3]!,
          def.vertices[index * 3 + 1]!,
          def.vertices[index * 3 + 2]!,
        )
        corners.push(x, y, z)
      }
      if (corners.length === 9) {
        soup.triangle(
          corners[0]!, corners[1]!, corners[2]!,
          corners[3]!, corners[4]!, corners[5]!,
          corners[6]!, corners[7]!, corners[8]!,
        )
      }
    }

    for (const component of def.components) {
      emit(component.objectid, multiply(component.transform, transform), depth + 1)
    }
  }

  // The build section says what actually gets printed, and where.
  let built = 0
  const buildBlock = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml)?.[1] ?? ''
  for (const item of tags(buildBlock, 'item')) {
    if (!item.objectid) continue
    emit(item.objectid, parseMatrix(item.transform), 0)
    built++
  }

  // Some exporters omit the build section entirely; fall back to every object
  // that carries geometry of its own.
  if (built === 0) {
    for (const [id, def] of objects) {
      if (def.triangles.length > 0) emit(id, IDENTITY, 0)
    }
  }

  if (soup.triangleCount === 0) {
    throw new MeshParseError('This 3MF has no triangles, so there is no surface to check.')
  }

  return {
    positions: soup.positions(),
    fileNormals: new Float32Array(soup.triangleCount * 3),
    triangleCount: soup.triangleCount,
    format: model?.unit && model.unit !== 'millimeter' ? `3MF (${model.unit})` : '3MF',
  }
}
