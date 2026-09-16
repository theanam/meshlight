import { MeshParseError, SoupBuilder } from './errors'
import { readZip } from './zip'
import type { ZipEntry } from './zip'
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
 *  machine-generated and flat, so a tag scanner is enough. Element names may
 *  carry a namespace prefix, so one is allowed for and ignored; attribute
 *  names keep theirs and are looked up by local name. */
function* tags(xml: string, name: string): Generator<Record<string, string>> {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*)>`, 'g')
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

/** Attribute lookup that ignores any namespace prefix, so `p:path` and
 *  `path` both resolve. The production extension's attributes are prefixed
 *  and the prefix is chosen by the writer. */
function attr(record: Record<string, string>, localName: string): string | undefined {
  const direct = record[localName]
  if (direct !== undefined) return direct
  for (const key of Object.keys(record)) {
    if (key.endsWith(`:${localName}`)) return record[key]
  }
  return undefined
}

interface ObjectDef {
  vertices: number[]
  triangles: number[]
  components: { key: string; transform: Matrix }[]
}

/** Objects are numbered per model part, so a part's own path scopes its ids.
 *  Without this, two parts that both define object "1" collide. */
function objectKey(path: string, id: string): string {
  return `${path}#${id}`
}

/** Resolve a `p:path` against the archive root the way OPC does. */
function normalisePath(path: string): string {
  return path.replace(/^\/+/, '')
}

/** Find the model part the build lives in.
 *
 *  The package relationships name it, but writers disagree on casing and
 *  path, so fall back to the conventional location and then to any part that
 *  looks like a model. */
async function rootModelPath(entries: ZipEntry[]): Promise<string | null> {
  const rels = entries.find((e) => /^_rels\/\.rels$/i.test(e.name))
  if (rels) {
    const xml = new TextDecoder().decode(await rels.read())
    for (const relationship of tags(xml, 'Relationship')) {
      const type = attr(relationship, 'Type') ?? ''
      const target = attr(relationship, 'Target')
      if (target && /3dmodel/i.test(type)) {
        const wanted = normalisePath(target).toLowerCase()
        const match = entries.find((e) => e.name.toLowerCase() === wanted)
        if (match) return match.name
      }
    }
  }
  return (
    entries.find((e) => /^3d\/3dmodel\.model$/i.test(e.name))?.name ??
    entries.find((e) => /\.model$/i.test(e.name))?.name ??
    null
  )
}

/** Read one model part's objects into the map, keyed by part path. */
function collectObjects(xml: string, path: string, into: Map<string, ObjectDef>, scale: number): void {
  const objectRe = /<(?:[\w.-]+:)?object\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?object>/g
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
      const objectid = attr(c, 'objectid')
      if (!objectid) continue
      // The production extension puts a referenced object in another part.
      const external = attr(c, 'path')
      def.components.push({
        key: objectKey(external ? normalisePath(external) : path, objectid),
        transform: parseMatrix(attr(c, 'transform')),
      })
    }
    into.set(objectKey(path, id), def)
  }
}

export async function parse3mf(buffer: ArrayBuffer): Promise<RawMesh> {
  const entries = readZip(buffer)
  const rootPath = await rootModelPath(entries)
  if (!rootPath) throw new MeshParseError('No 3D model found inside this 3MF file.')

  const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]))
  const rootXml = new TextDecoder().decode(await byName.get(rootPath.toLowerCase())!.read())

  const model = tags(rootXml, 'model').next().value as Record<string, string> | undefined
  const unit = attr(model ?? {}, 'unit') ?? 'millimeter'
  const scale = UNIT_TO_MM[unit] ?? 1

  const objects = new Map<string, ObjectDef>()
  collectObjects(rootXml, rootPath, objects, scale)

  // Load referenced parts on demand. Bambu, Orca and PrusaSlicer all use the
  // production extension, where the root model is a few kilobytes of build
  // instructions and every triangle lives in 3D/Objects/*.model.
  const loaded = new Set([rootPath.toLowerCase()])
  for (let pass = 0; pass < 16; pass++) {
    const missing = new Set<string>()
    for (const def of objects.values()) {
      for (const component of def.components) {
        const path = component.key.slice(0, component.key.lastIndexOf('#'))
        if (!objects.has(component.key) && !loaded.has(path.toLowerCase())) missing.add(path)
      }
    }
    if (missing.size === 0) break
    for (const path of missing) {
      loaded.add(path.toLowerCase())
      const entry = byName.get(path.toLowerCase())
      if (!entry) continue
      collectObjects(new TextDecoder().decode(await entry.read()), path, objects, scale)
    }
  }

  if (objects.size === 0) throw new MeshParseError('This 3MF contains no objects.')

  const soup = new SoupBuilder()
  const emit = (key: string, transform: Matrix, depth: number): void => {
    // Components can nest, and a malformed file could make them cycle.
    if (depth > 16) return
    const def = objects.get(key)
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
      emit(component.key, multiply(component.transform, transform), depth + 1)
    }
  }

  // The build section says what actually gets printed, and where.
  let built = 0
  const buildBlock = /<(?:[\w.-]+:)?build\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?build>/.exec(rootXml)?.[1] ?? ''
  for (const item of tags(buildBlock, 'item')) {
    const objectid = attr(item, 'objectid')
    if (!objectid) continue
    const external = attr(item, 'path')
    emit(
      objectKey(external ? normalisePath(external) : rootPath, objectid),
      parseMatrix(attr(item, 'transform')),
      0,
    )
    built++
  }

  // Some exporters omit the build section entirely; fall back to every object
  // that carries geometry of its own.
  if (built === 0) {
    for (const [key, def] of objects) {
      if (def.triangles.length > 0) emit(key, IDENTITY, 0)
    }
  }

  if (soup.triangleCount === 0) {
    throw new MeshParseError('This 3MF has no triangles, so there is no surface to check.')
  }

  return {
    positions: soup.positions(),
    fileNormals: new Float32Array(soup.triangleCount * 3),
    triangleCount: soup.triangleCount,
    format: unit !== 'millimeter' ? `3MF (${unit})` : '3MF',
  }
}
