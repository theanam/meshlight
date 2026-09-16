/* Exercises the pure pipeline (parse -> index -> analyse -> score -> slice)
 * on hand-built meshes whose correct answers are known by construction.
 * Run with: npm test */

import { analyseMesh } from '../src/core/analysis'
import { indexMesh } from '../src/core/indexer'
import { scoreMesh } from '../src/core/score'
import { orientedFootprint, plateFit } from '../src/core/footprint'
import { buildZBuckets, sectionAt } from '../src/core/section'
// Aliased: this file has its own toBinaryStl fixture helper.
import { repairMesh, toBinaryStl as exportStl } from '../src/core/repair'
import {
  concatMeshes,
  cutMesh,
  cutPart,
  deleteShell,
  extractShell,
  rotatePart,
  scalePart,
} from '../src/core/edit'
import { MeshParseError } from '../src/core/formats/errors'
import { parseStl } from '../src/core/formats/stl'
import { parseMesh } from '../src/core/mesh-loader'
import { DEFAULT_SETTINGS, MAX_INSTANCES } from '../src/core/types'

let failures = 0
let checks = 0

/** Floating point comparisons need a tolerance; two decimals is plenty for
 *  millimetres and keeps the expected values in these tests readable. */
function round(n: number): number {
  return Math.round(n * 100) / 100
}

function check(label: string, actual: unknown, expected: unknown): void {
  checks++
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures++
    console.error(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  } else {
    console.log(`  ok   ${label}`)
  }
}

/** The 12 triangles of a unit cube, wound counter-clockwise seen from
 *  outside, as [ax,ay,az, bx,by,bz, cx,cy,cz] per face. */
function cubeTriangles(size = 10): number[][] {
  const s = size
  const v = [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
  ]
  const quads: [number, number, number, number][] = [
    [0, 3, 2, 1], // bottom (-Z)
    [4, 5, 6, 7], // top (+Z)
    [0, 1, 5, 4], // -Y
    [1, 2, 6, 5], // +X
    [2, 3, 7, 6], // +Y
    [3, 0, 4, 7], // -X
  ]
  const faces: number[][] = []
  for (const [a, b, c, d] of quads) {
    faces.push([...v[a]!, ...v[b]!, ...v[c]!])
    faces.push([...v[a]!, ...v[c]!, ...v[d]!])
  }
  return faces
}

function toBinaryStl(faces: number[][]): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + faces.length * 50)
  const view = new DataView(buffer)
  view.setUint32(80, faces.length, true)
  let offset = 84
  for (const face of faces) {
    // Leave the file normal at zero — we recompute from winding anyway.
    for (let i = 0; i < 9; i++) view.setFloat32(offset + 12 + i * 4, face[i]!, true)
    offset += 50
  }
  return buffer
}

function toAsciiStl(faces: number[][]): ArrayBuffer {
  let text = 'solid test\n'
  for (const f of faces) {
    text += 'facet normal 0 0 0\n  outer loop\n'
    for (let c = 0; c < 3; c++) text += `    vertex ${f[c * 3]} ${f[c * 3 + 1]} ${f[c * 3 + 2]}\n`
    text += '  endloop\nendfacet\n'
  }
  text += 'endsolid test\n'
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

function pipeline(faces: number[][], binary = true) {
  const raw = parseStl(binary ? toBinaryStl(faces) : toAsciiStl(faces))
  const mesh = indexMesh(raw, DEFAULT_SETTINGS.weldEpsilon)
  const analysis = analyseMesh(mesh)
  const buckets = buildZBuckets(mesh)
  return { raw, mesh, analysis, buckets }
}

console.log('\nclean cube (binary)')
{
  const { raw, mesh, analysis } = pipeline(cubeTriangles())
  check('format detected', raw.format, 'STL (binary)')
  check('12 triangles', mesh.triangleCount, 12)
  check('welds to 8 vertices', mesh.vertexCount, 8)
  check('watertight', analysis.watertight, true)
  check('no boundary edges', analysis.boundaryEdges.length, 0)
  check('no non-manifold edges', analysis.nonManifoldEdges.length, 0)
  check('no flipped faces', analysis.flippedTriangles.length, 0)
  check('no degenerate faces', analysis.degenerateTriangles.length, 0)
  check('single shell', analysis.shells.length, 1)
  check('positive volume', analysis.shells[0]!.signedVolume > 0, true)
  check('no issues reported', analysis.issues.length, 0)
}

console.log('\nclean cube (ascii)')
{
  const { raw, mesh, analysis } = pipeline(cubeTriangles(), false)
  check('format detected', raw.format, 'STL (ascii)')
  check('12 triangles', mesh.triangleCount, 12)
  check('welds to 8 vertices', mesh.vertexCount, 8)
  check('watertight', analysis.watertight, true)
}

console.log('\ncube with one face removed (a hole)')
{
  const faces = cubeTriangles()
  faces.splice(2, 1) // drop half of the top face
  const { analysis } = pipeline(faces)
  check('not watertight', analysis.watertight, false)
  check('3 boundary edges', analysis.boundaryEdges.length, 3)
  check('reports a boundary issue', analysis.issues[0]!.kind, 'boundary')
}

console.log('\ncube with one face wound backwards')
{
  const faces = cubeTriangles()
  const f = faces[5]!
  // Swap corners b and c to reverse the winding of a single face.
  faces[5] = [f[0]!, f[1]!, f[2]!, f[6]!, f[7]!, f[8]!, f[3]!, f[4]!, f[5]!]
  const { analysis } = pipeline(faces)
  check('one flipped face', analysis.flippedTriangles.length, 1)
  check('still watertight', analysis.watertight, true)
}

console.log('\nfully inverted cube')
{
  // Reverse every face: the solid is closed but points inward.
  const faces = cubeTriangles().map((f) => [
    f[0]!, f[1]!, f[2]!, f[6]!, f[7]!, f[8]!, f[3]!, f[4]!, f[5]!,
  ])
  const { analysis } = pipeline(faces)
  check('negative volume', analysis.shells[0]!.signedVolume < 0, true)
  check('every face flagged flipped', analysis.flippedTriangles.length, 12)
}

console.log('\ntwo disconnected cubes')
{
  const faces = [
    ...cubeTriangles(10),
    ...cubeTriangles(10).map((f) => f.map((n, i) => (i % 3 === 0 ? n + 40 : n))),
  ]
  const { analysis } = pipeline(faces)
  check('two shells', analysis.shells.length, 2)
  check('watertight overall', analysis.watertight, true)
  check('reports a shells note', analysis.issues.some((i) => i.kind === 'shells'), true)
}

console.log('\ndegenerate face')
{
  const faces = cubeTriangles()
  faces.push([0, 0, 0, 5, 0, 0, 10, 0, 0]) // three collinear points: zero area
  const { analysis } = pipeline(faces)
  check('one degenerate face', analysis.degenerateTriangles.length, 1)
}

console.log('\nnon-manifold edge (three faces on one edge)')
{
  const faces = cubeTriangles()
  faces.push([0, 0, 0, 10, 0, 0, 5, -8, 5]) // a fin sharing the cube's bottom edge
  const { analysis } = pipeline(faces)
  check('one non-manifold edge', analysis.nonManifoldEdges.length, 1)
  check('not watertight', analysis.watertight, false)
}

console.log('\nslicing a cube')
{
  const { mesh, buckets } = pipeline(cubeTriangles(10))
  const mid = sectionAt(mesh, buckets, 5)
  check('mid-height slice returns segments', mid.length > 0, true)
  // A cube cut halfway up is a square: 4 sides, 2 triangles each.
  check('segment count matches the cut faces', mid.length / 4, 8)
  const above = sectionAt(mesh, buckets, 999)
  check('slice above the model is empty', above.length, 0)
}

console.log('\nscoring')
{
  const { mesh, analysis, buckets } = pipeline(cubeTriangles(10))
  const score = scoreMesh(mesh, analysis, buckets, DEFAULT_SETTINGS)
  check('five components', score.components.length, 5)
  check('watertight component passes', score.components[0]!.status, 'pass')
  check('score in range', score.total >= 0 && score.total <= 100, true)
  check('clean cube scores well', score.total >= 70, true)

  const tiny = scoreMesh(mesh, analysis, buckets, { ...DEFAULT_SETTINGS, buildVolume: [5, 5, 5] })
  check('oversized part loses build-volume points', tiny.components[4]!.status, 'fail')
}

console.log('\nper-defect instances')
{
  const faces = cubeTriangles()
  faces.splice(2, 1)
  const { analysis } = pipeline(faces)
  const boundary = analysis.issues.find((i) => i.kind === 'boundary')!
  check('one instance per open edge', boundary.instances.length, 3)
  check('nothing hidden below the cap', boundary.hiddenInstances, 0)
  check('every instance has a focus point', boundary.instances.every((i) => i.focus.length === 3), true)
  check('every instance has a positive radius', boundary.instances.every((i) => i.radius > 0), true)
  // The camera distance derives from radius, so a zero would fly it inside.
  // meta is rounded for display, so compare against it loosely.
  const shown = Number(boundary.instances[0]!.meta.split(' ')[0])
  check('edge radius is half its length', Math.abs(shown / 2 - boundary.instances[0]!.radius) < 0.01, true)
}

console.log('\ninstance cap on a defect-heavy mesh')
{
  // A fan of loose triangles: every one contributes open edges, far past the cap.
  const faces: number[][] = []
  for (let i = 0; i < 400; i++) faces.push([i, 0, 0, i + 1, 0, 0, i, 1, 0])
  const { analysis } = pipeline(faces)
  const boundary = analysis.issues.find((i) => i.kind === 'boundary')!
  check('instances capped', boundary.instances.length, MAX_INSTANCES)
  check('count still reports the true total', boundary.count > MAX_INSTANCES, true)
  check('remainder is reported', boundary.hiddenInstances, boundary.count - MAX_INSTANCES)
}

console.log('\nrepair: fill a hole')
{
  const faces = cubeTriangles()
  faces.splice(2, 1) // remove half the top face
  const { mesh, analysis } = pipeline(faces)
  check('starts not watertight', analysis.watertight, false)

  const fixed = repairMesh(mesh, { fillHoles: true, fixWinding: false, dropDegenerate: false })
  const after = analyseMesh(fixed.mesh)
  check('one loop filled', fixed.stats.filledLoops, 1)
  check('patch is a single triangle', fixed.stats.addedTriangles, 1)
  check('now watertight', after.watertight, true)
  check('no boundary edges left', after.boundaryEdges.length, 0)
  check('still one shell', after.shells.length, 1)
  check('volume still positive', after.shells[0]!.signedVolume > 0, true)
  check('patch buffer matches added faces', fixed.patch.length, fixed.stats.addedTriangles * 9)
}

console.log('\nrepair: fill a larger hole')
{
  // Remove a whole face of the cube, leaving a 4-edge boundary loop.
  const faces = cubeTriangles()
  faces.splice(2, 2)
  const { mesh } = pipeline(faces)
  const fixed = repairMesh(mesh, { fillHoles: true, fixWinding: false, dropDegenerate: false })
  const after = analyseMesh(fixed.mesh)
  check('one loop filled', fixed.stats.filledLoops, 1)
  check('ear clipping used n-2 triangles', fixed.stats.addedTriangles, 2)
  check('now watertight', after.watertight, true)
  check('outward facing', after.shells[0]!.signedVolume > 0, true)
  check('no flipped faces introduced', after.flippedTriangles.length, 0)
}

console.log('\nrepair: re-wind flipped faces')
{
  const faces = cubeTriangles()
  const f = faces[5]!
  faces[5] = [f[0]!, f[1]!, f[2]!, f[6]!, f[7]!, f[8]!, f[3]!, f[4]!, f[5]!]
  const { mesh, analysis } = pipeline(faces)
  check('starts with one flipped face', analysis.flippedTriangles.length, 1)

  const fixed = repairMesh(mesh, { fillHoles: false, fixWinding: true, dropDegenerate: false })
  const after = analyseMesh(fixed.mesh)
  check('one face rewound', fixed.stats.rewoundTriangles, 1)
  check('no flipped faces left', after.flippedTriangles.length, 0)
  check('triangle count unchanged', fixed.mesh.triangleCount, mesh.triangleCount)
}

console.log('\nrepair: re-wind a fully inverted solid')
{
  const faces = cubeTriangles().map((f) => [
    f[0]!, f[1]!, f[2]!, f[6]!, f[7]!, f[8]!, f[3]!, f[4]!, f[5]!,
  ])
  const { mesh, analysis } = pipeline(faces)
  check('starts inside-out', analysis.shells[0]!.signedVolume < 0, true)

  const fixed = repairMesh(mesh, { fillHoles: false, fixWinding: true, dropDegenerate: false })
  const after = analyseMesh(fixed.mesh)
  check('all 12 faces rewound', fixed.stats.rewoundTriangles, 12)
  check('now encloses positive volume', after.shells[0]!.signedVolume > 0, true)
  check('no flipped faces reported', after.flippedTriangles.length, 0)
}

console.log('\nrepair: drop degenerate faces')
{
  const faces = cubeTriangles()
  faces.push([0, 0, 0, 5, 0, 0, 10, 0, 0])
  const { mesh, analysis } = pipeline(faces)
  check('starts with one degenerate', analysis.degenerateTriangles.length, 1)

  const fixed = repairMesh(mesh, { fillHoles: false, fixWinding: false, dropDegenerate: true })
  const after = analyseMesh(fixed.mesh)
  check('one face removed', fixed.stats.removedTriangles, 1)
  check('12 faces remain', fixed.mesh.triangleCount, 12)
  check('none degenerate', after.degenerateTriangles.length, 0)
  check('still watertight', after.watertight, true)
}

console.log('\nrepair: all three together on a messy mesh')
{
  const faces = cubeTriangles()
  faces.splice(2, 1)                                   // hole
  const g = faces[4]!
  faces[4] = [g[0]!, g[1]!, g[2]!, g[6]!, g[7]!, g[8]!, g[3]!, g[4]!, g[5]!] // flipped
  faces.push([0, 0, 0, 5, 0, 0, 10, 0, 0])             // degenerate
  const { mesh, analysis } = pipeline(faces)
  check('starts broken', analysis.issues.length >= 3, true)

  const fixed = repairMesh(mesh, { fillHoles: true, fixWinding: true, dropDegenerate: true })
  const after = analyseMesh(fixed.mesh)
  check('watertight after repair', after.watertight, true)
  check('no flipped faces', after.flippedTriangles.length, 0)
  check('no degenerate faces', after.degenerateTriangles.length, 0)
  check('single shell', after.shells.length, 1)
  check('outward facing', after.shells[0]!.signedVolume > 0, true)
  check('reports nothing', after.issues.length, 0)
}

console.log('\nrepair: a clean mesh is left alone')
{
  const { mesh } = pipeline(cubeTriangles())
  const fixed = repairMesh(mesh, { fillHoles: true, fixWinding: true, dropDegenerate: true })
  check('nothing filled', fixed.stats.filledLoops, 0)
  check('nothing rewound', fixed.stats.rewoundTriangles, 0)
  check('nothing removed', fixed.stats.removedTriangles, 0)
  check('triangle count unchanged', fixed.mesh.triangleCount, 12)
}

console.log('\nrepair: export round-trips')
{
  const faces = cubeTriangles()
  faces.splice(2, 1)
  const { mesh } = pipeline(faces)
  const fixed = repairMesh(mesh, { fillHoles: true, fixWinding: true, dropDegenerate: true })

  const stl = exportStl(fixed.mesh)
  const reloaded = indexMesh(parseStl(stl), DEFAULT_SETTINGS.weldEpsilon)
  const after = analyseMesh(reloaded)
  check('same triangle count', reloaded.triangleCount, fixed.mesh.triangleCount)
  check('still watertight after a round trip', after.watertight, true)
  check('bounds preserved', reloaded.bounds.size.map((n) => Math.round(n)), [10, 10, 10])
}

// ---------------------------------------------------------------------------
// Other mesh formats. Each one is fed the same cube and must land on exactly
// the same topology as the STL path, since everything downstream assumes it.
// ---------------------------------------------------------------------------

function toObj(faces: number[][]): ArrayBuffer {
  let text = '# test cube\n'
  const seen = new Map<string, number>()
  const order: string[] = []
  const indexOf = (x: number, y: number, z: number): number => {
    const key = `${x} ${y} ${z}`
    let i = seen.get(key)
    if (i === undefined) { i = seen.size + 1; seen.set(key, i); order.push(key) }
    return i
  }
  const lines: string[] = []
  for (const f of faces) {
    const a = indexOf(f[0]!, f[1]!, f[2]!)
    const b = indexOf(f[3]!, f[4]!, f[5]!)
    const c = indexOf(f[6]!, f[7]!, f[8]!)
    lines.push(`f ${a}//1 ${b}//1 ${c}//1`)
  }
  for (const key of order) text += `v ${key}\n`
  text += 'vn 0 0 1\n' + lines.join('\n') + '\n'
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

function toAsciiPly(faces: number[][]): ArrayBuffer {
  const seen = new Map<string, number>()
  const order: string[] = []
  const indexOf = (x: number, y: number, z: number): number => {
    const key = `${x} ${y} ${z}`
    let i = seen.get(key)
    if (i === undefined) { i = seen.size; seen.set(key, i); order.push(key) }
    return i
  }
  const faceLines = faces.map((f) =>
    `3 ${indexOf(f[0]!, f[1]!, f[2]!)} ${indexOf(f[3]!, f[4]!, f[5]!)} ${indexOf(f[6]!, f[7]!, f[8]!)}`)
  const text =
    'ply\nformat ascii 1.0\n' +
    `element vertex ${order.length}\nproperty float x\nproperty float y\nproperty float z\n` +
    `element face ${faces.length}\nproperty list uchar int vertex_indices\nend_header\n` +
    order.join('\n') + '\n' + faceLines.join('\n') + '\n'
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

function toBinaryPly(faces: number[][]): ArrayBuffer {
  const seen = new Map<string, number[]>()
  const order: number[][] = []
  const indexOf = (x: number, y: number, z: number): number => {
    const key = `${x} ${y} ${z}`
    if (!seen.has(key)) { seen.set(key, [x, y, z]); order.push([x, y, z]) }
    return order.findIndex((v) => v[0] === x && v[1] === y && v[2] === z)
  }
  const tris = faces.map((f) => [
    indexOf(f[0]!, f[1]!, f[2]!), indexOf(f[3]!, f[4]!, f[5]!), indexOf(f[6]!, f[7]!, f[8]!),
  ])
  const header =
    'ply\nformat binary_little_endian 1.0\n' +
    `element vertex ${order.length}\nproperty float x\nproperty float y\nproperty float z\n` +
    `element face ${tris.length}\nproperty list uchar int vertex_indices\nend_header\n`
  const head = new TextEncoder().encode(header)
  const body = new ArrayBuffer(order.length * 12 + tris.length * 13)
  const view = new DataView(body)
  let o = 0
  for (const v of order) { for (const n of v) { view.setFloat32(o, n, true); o += 4 } }
  for (const t of tris) {
    view.setUint8(o, 3); o += 1
    for (const n of t) { view.setInt32(o, n, true); o += 4 }
  }
  const out = new Uint8Array(head.length + body.byteLength)
  out.set(head, 0)
  out.set(new Uint8Array(body), head.length)
  return out.buffer as ArrayBuffer
}

console.log('\nOBJ')
{
  const mesh = indexMesh(await parseMesh(toObj(cubeTriangles()), 'cube.obj'), DEFAULT_SETTINGS.weldEpsilon)
  const a = analyseMesh(mesh)
  check('12 triangles', mesh.triangleCount, 12)
  check('welds to 8 vertices', mesh.vertexCount, 8)
  check('watertight', a.watertight, true)
  check('outward facing', a.shells[0]!.signedVolume > 0, true)
}

console.log('\nOBJ with negative indices and quads')
{
  // A single quad written with relative indices, as streaming exporters do.
  const text = 'v 0 0 0\nv 10 0 0\nv 10 10 0\nv 0 10 0\nf -4 -3 -2 -1\n'
  const raw = await parseMesh(new TextEncoder().encode(text).buffer as ArrayBuffer, 'quad.obj')
  check('quad fans into 2 triangles', raw.triangleCount, 2)
  check('format reported', raw.format, 'OBJ')
}

console.log('\nPLY (ascii)')
{
  const raw = await parseMesh(toAsciiPly(cubeTriangles()), 'cube.ply')
  const mesh = indexMesh(raw, DEFAULT_SETTINGS.weldEpsilon)
  const a = analyseMesh(mesh)
  check('format reported', raw.format, 'PLY (ascii)')
  check('12 triangles', mesh.triangleCount, 12)
  check('welds to 8 vertices', mesh.vertexCount, 8)
  check('watertight', a.watertight, true)
}

console.log('\nPLY (binary)')
{
  const raw = await parseMesh(toBinaryPly(cubeTriangles()), 'cube.ply')
  const mesh = indexMesh(raw, DEFAULT_SETTINGS.weldEpsilon)
  const a = analyseMesh(mesh)
  check('format reported', raw.format, 'PLY (binary)')
  check('12 triangles', mesh.triangleCount, 12)
  check('watertight', a.watertight, true)
  check('outward facing', a.shells[0]!.signedVolume > 0, true)
}

console.log('\nformat sniffing beats the extension')
{
  // A PLY that claims to be an STL must still be read as a PLY.
  const raw = await parseMesh(toAsciiPly(cubeTriangles()), 'mislabelled.stl')
  check('sniffed as PLY', raw.format, 'PLY (ascii)')
}

/** Build a real ZIP so the 3MF path exercises the container, not a stub.
 *  `deflate` uses CompressionStream, the mirror of the reader's own
 *  DecompressionStream, so both halves are the platform's. */
async function toZip(
  entries: { name: string; text: string }[],
  deflate: boolean,
  zip64 = false,
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const rawBytes = encoder.encode(entry.text)
    const data = deflate
      ? new Uint8Array(
          await new Response(
            new Blob([rawBytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw')),
          ).arrayBuffer(),
        )
      : rawBytes

    const local = new Uint8Array(30 + nameBytes.length + data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(8, deflate ? 8 : 0, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, rawBytes.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    locals.push(local)

    // ZIP64 puts 0xFFFFFFFF in the 32-bit fields and the real values in an
    // extra block — which is what plenty of small real-world 3MF files do.
    const extraLength = zip64 ? 28 : 0
    const central = new Uint8Array(46 + nameBytes.length + extraLength)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, deflate ? 8 : 0, true)
    cv.setUint32(20, zip64 ? 0xffffffff : data.length, true)
    cv.setUint32(24, zip64 ? 0xffffffff : rawBytes.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, extraLength, true)
    cv.setUint32(42, zip64 ? 0xffffffff : offset, true)
    central.set(nameBytes, 46)
    if (zip64) {
      const ev2 = new DataView(central.buffer, 46 + nameBytes.length)
      ev2.setUint16(0, 0x0001, true)
      ev2.setUint16(2, 24, true)
      ev2.setBigUint64(4, BigInt(rawBytes.length), true)
      ev2.setBigUint64(12, BigInt(data.length), true)
      ev2.setBigUint64(20, BigInt(offset), true)
    }
    centrals.push(central)

    offset += local.length
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const tail: Uint8Array[] = []

  if (zip64) {
    const record = new Uint8Array(56)
    const rv = new DataView(record.buffer)
    rv.setUint32(0, 0x06064b50, true)
    rv.setBigUint64(4, 44n, true)
    rv.setBigUint64(24, BigInt(entries.length), true)
    rv.setBigUint64(32, BigInt(entries.length), true)
    rv.setBigUint64(40, BigInt(centralSize), true)
    rv.setBigUint64(48, BigInt(offset), true)
    tail.push(record)

    const locator = new Uint8Array(20)
    const lv2 = new DataView(locator.buffer)
    lv2.setUint32(0, 0x07064b50, true)
    lv2.setBigUint64(8, BigInt(offset + centralSize), true)
    lv2.setUint32(16, 1, true)
    tail.push(locator)
  }

  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, zip64 ? 0xffff : entries.length, true)
  ev.setUint16(10, zip64 ? 0xffff : entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, zip64 ? 0xffffffff : offset, true)
  tail.push(eocd)

  const parts = [...locals, ...centrals, ...tail]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let cursor = 0
  for (const part of parts) { out.set(part, cursor); cursor += part.length }
  return out.buffer as ArrayBuffer
}

function modelXml(faces: number[][], unit = 'millimeter', transform?: string): string {
  const seen = new Map<string, number>()
  const order: string[] = []
  const indexOf = (x: number, y: number, z: number): number => {
    const key = `${x},${y},${z}`
    let i = seen.get(key)
    if (i === undefined) { i = seen.size; seen.set(key, i); order.push(key) }
    return i
  }
  const tris = faces.map((f) =>
    `<triangle v1="${indexOf(f[0]!, f[1]!, f[2]!)}" v2="${indexOf(f[3]!, f[4]!, f[5]!)}" v3="${indexOf(f[6]!, f[7]!, f[8]!)}" />`)
  const verts = order.map((k) => {
    const [x, y, z] = k.split(',')
    return `<vertex x="${x}" y="${y}" z="${z}" />`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="1" type="model">
   <mesh>
    <vertices>${verts.join('')}</vertices>
    <triangles>${tris.join('')}</triangles>
   </mesh>
  </object>
 </resources>
 <build><item objectid="1"${transform ? ` transform="${transform}"` : ''} /></build>
</model>`
}

console.log('\n3MF (stored)')
{
  const zip = await toZip([{ name: '3D/3dmodel.model', text: modelXml(cubeTriangles()) }], false)
  const raw = await parseMesh(zip, 'cube.3mf')
  const mesh = indexMesh(raw, DEFAULT_SETTINGS.weldEpsilon)
  const a = analyseMesh(mesh)
  check('format reported', raw.format, '3MF')
  check('12 triangles', mesh.triangleCount, 12)
  check('welds to 8 vertices', mesh.vertexCount, 8)
  check('watertight', a.watertight, true)
  check('outward facing', a.shells[0]!.signedVolume > 0, true)
}

console.log('\n3MF (deflated, with other entries)')
{
  const zip = await toZip([
    { name: '[Content_Types].xml', text: '<Types/>' },
    { name: '_rels/.rels', text: '<Relationships/>' },
    { name: '3D/3dmodel.model', text: modelXml(cubeTriangles()) },
  ], true)
  const mesh = indexMesh(await parseMesh(zip, 'cube.3mf'), DEFAULT_SETTINGS.weldEpsilon)
  check('finds the model past other entries', mesh.triangleCount, 12)
  check('welds to 8 vertices', mesh.vertexCount, 8)
  check('watertight', analyseMesh(mesh).watertight, true)
}

console.log('\n3MF units are converted to mm')
{
  const zip = await toZip([{ name: '3D/3dmodel.model', text: modelXml(cubeTriangles(1), 'inch') }], true)
  const raw = await parseMesh(zip, 'inches.3mf')
  const mesh = indexMesh(raw, DEFAULT_SETTINGS.weldEpsilon)
  check('unit noted in the format', raw.format, '3MF (inch)')
  check('1 inch cube becomes 25.4 mm', mesh.bounds.size.map((n) => Math.round(n * 10) / 10), [25.4, 25.4, 25.4])
}

console.log('\n3MF build transforms are applied')
{
  // Translate the cube 100mm along X via the build item transform.
  const zip = await toZip(
    [{ name: '3D/3dmodel.model', text: modelXml(cubeTriangles(), 'millimeter', '1 0 0 0 1 0 0 0 1 100 0 0') }],
    true,
  )
  const mesh = indexMesh(await parseMesh(zip, 'moved.3mf'), DEFAULT_SETTINGS.weldEpsilon)
  check('translated on X', Math.round(mesh.bounds.min[0]), 100)
  check('size unchanged', mesh.bounds.size.map((n) => Math.round(n)), [10, 10, 10])
}

console.log('\n3MF sniffed without an extension')
{
  const zip = await toZip([{ name: '3D/3dmodel.model', text: modelXml(cubeTriangles()) }], true)
  const raw = await parseMesh(zip, 'no-extension')
  check('recognised from its ZIP magic', raw.format, '3MF')
}

console.log('\n3MF in a ZIP64 archive')
{
  // Real 3MF writers opt into ZIP64 regardless of size, so the ordinary
  // end-of-central-directory holds sentinels and the real offsets live in a
  // ZIP64 record behind it. Reading only the 32-bit fields finds no entries.
  const zip = await toZip([
    { name: '[Content_Types].xml', text: '<Types/>' },
    { name: '3D/3dmodel.model', text: modelXml(cubeTriangles()) },
  ], true, true)
  const mesh = indexMesh(await parseMesh(zip, 'zip64.3mf'), DEFAULT_SETTINGS.weldEpsilon)
  check('12 triangles', mesh.triangleCount, 12)
  check('watertight', analyseMesh(mesh).watertight, true)
}

console.log('\n3MF production extension (geometry in a separate part)')
{
  // Bambu, Orca and PrusaSlicer write a few kilobytes of build instructions
  // into 3D/3dmodel.model and put every triangle in 3D/Objects/*.model.
  const root = `<?xml version="1.0"?>
<model unit="millimeter">
 <resources>
  <object id="1" type="model">
   <components><component objectid="7" p:path="/3D/Objects/part.model" /></components>
  </object>
 </resources>
 <build><item objectid="1" /></build>
</model>`
  const part = `<?xml version="1.0"?>
<model unit="millimeter"><resources>${modelXml(cubeTriangles()).replace(/[\s\S]*<resources>/, '').replace(/<\/resources>[\s\S]*/, '')}</resources></model>`
    .replace('id="1"', 'id="7"')

  const zip = await toZip([
    { name: '_rels/.rels', text: '<Relationships><Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model" /></Relationships>' },
    { name: '3D/3dmodel.model', text: root },
    { name: '3D/Objects/part.model', text: part },
  ], true, true)

  const mesh = indexMesh(await parseMesh(zip, 'production.3mf'), DEFAULT_SETTINGS.weldEpsilon)
  check('geometry pulled from the referenced part', mesh.triangleCount, 12)
  check('welds to 8 vertices', mesh.vertexCount, 8)
  check('watertight', analyseMesh(mesh).watertight, true)
}

console.log('\n3MF with namespace-prefixed elements')
{
  const xml = modelXml(cubeTriangles())
    .replace(/<vertex /g, '<m:vertex ')
    .replace(/<triangle /g, '<m:triangle ')
    .replace(/<object /g, '<m:object ').replace(/<\/object>/g, '</m:object>')
    .replace(/<build>/g, '<m:build>').replace(/<\/build>/g, '</m:build>')
    .replace(/<item /g, '<m:item ')
  const zip = await toZip([{ name: '3D/3dmodel.model', text: xml }], true)
  const mesh = indexMesh(await parseMesh(zip, 'prefixed.3mf'), DEFAULT_SETTINGS.weldEpsilon)
  check('prefixes ignored', mesh.triangleCount, 12)
  check('watertight', analyseMesh(mesh).watertight, true)
}

console.log('\nmalformed input')
{
  const bad = (buffer: ArrayBuffer): string => {
    try {
      parseStl(buffer)
      return 'no error'
    } catch (error) {
      return error instanceof MeshParseError ? 'MeshParseError' : 'wrong error'
    }
  }
  check('empty file', bad(new ArrayBuffer(0)), 'MeshParseError')
  check('tiny file', bad(new ArrayBuffer(4)), 'MeshParseError')
  check('random bytes', bad(new TextEncoder().encode('this is not an stl at all').buffer as ArrayBuffer), 'MeshParseError')
}

// ---------------------------------------------------------------------------
// Oriented footprint
// ---------------------------------------------------------------------------

{
  console.log('\noriented footprint: the box follows the part, not the axes')

  /** Four corners of a w x d rectangle, turned `deg` about Z and moved off
   *  the origin so a wrong centre cannot pass by landing on (0, 0). */
  function turnedRect(w: number, d: number, deg: number): Float32Array {
    const a = (deg * Math.PI) / 180
    const out = new Float32Array(12)
    const corners: [number, number][] = [
      [-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2],
    ]
    corners.forEach(([x, y], i) => {
      out[i * 3] = 12 + x * Math.cos(a) - y * Math.sin(a)
      out[i * 3 + 1] = -5 + x * Math.sin(a) + y * Math.cos(a)
    })
    return out
  }
  const corners = Uint32Array.from([0, 1, 2, 3])
  const round = (n: number): number => Math.round(n * 100) / 100
  const sides = (w: number, d: number, deg: number): number[] => {
    const f = orientedFootprint(turnedRect(w, d, deg), corners)!
    return [round(f.width), round(f.depth)].sort((a, b) => b - a)
  }
  const degrees = (w: number, d: number, deg: number): number =>
    round((orientedFootprint(turnedRect(w, d, deg), corners)!.angle * 180) / Math.PI)

  check('square to the axes', sides(200, 30, 0), [200, 30])
  check('turned 30 degrees', sides(200, 30, 30), [200, 30])
  // The case that started this: axis-aligned extents say 155 x 155.
  check('turned 45 degrees', sides(200, 30, 45), [200, 30])
  check('angle found', degrees(200, 30, 30), 30)
  // A rectangle is itself again every quarter turn, so this is 0, not 90.
  check('quarter turn folds to zero', degrees(200, 30, 90), 0)
  check('centre is the rectangle, not the origin', (() => {
    const f = orientedFootprint(turnedRect(200, 30, 45), corners)!
    return [round(f.center[0]), round(f.center[1])]
  })(), [12, -5])
  check('no points, no footprint', orientedFootprint(new Float32Array(0), new Uint32Array(0)), null)

  console.log('\nplate fit: every orientation, not just the two the axes offer')

  // A 200 x 30 bar laid at 45 degrees measures 162.6 x 162.6 axis-aligned, so
  // comparing extents to the bed calls it far too big for a plate it drops
  // onto with 10 mm to spare once turned back.
  const diagonalBar = turnedRect(200, 30, 45)
  const onNarrowBed = plateFit(diagonalBar, 210, 40)!
  check('diagonal bar fits once turned', onNarrowBed.fits, true)
  check('and the turn is reported', round((onNarrowBed.angle * 180) / Math.PI), 45)
  check('at its real size', [round(onNarrowBed.width), round(onNarrowBed.depth)], [200, 30])

  const squareOn = plateFit(turnedRect(100, 50, 0), 200, 200)!
  check('a part that already fits is not told to turn', squareOn.angle, 0)
  check('and it fits', squareOn.fits, true)

  const tooBig = plateFit(turnedRect(300, 30, 20), 210, 40)!
  check('too big at every angle', tooBig.fits, false)
  check('overflow is measured at the best angle', round(tooBig.overflow), 90)
}


console.log('\nediting: delete, scale, rotate')
{
  /** Two separate cubes, the second offset well clear of the first. */
  const twoCubes = (): number[][] => {
    const a = cubeTriangles(10)
    const b = cubeTriangles(10).map((face) =>
      face.map((value, i) => (i % 3 === 0 ? value + 40 : value)),
    )
    return [...a, ...b]
  }

  const shellIdsOf = (mesh: { triangleCount: number }, shells: { triangles: Uint32Array }[]) => {
    const ids = new Uint32Array(mesh.triangleCount)
    shells.forEach((shell, index) => {
      for (const t of shell.triangles) ids[t] = index
    })
    return ids
  }

  const { mesh, analysis } = pipeline(twoCubes())
  check('two shells to work with', analysis.shells.length, 2)
  const ids = shellIdsOf(mesh, analysis.shells)

  // ---- delete ----
  const afterDelete = deleteShell(mesh, ids, 0)
  check('delete leaves one cube', afterDelete.triangleCount, 12)
  check('and drops its vertices too', afterDelete.vertexCount, 8)
  check('the survivor is still watertight', analyseMesh(afterDelete).watertight, true)
  check('the survivor is the one we kept', round(afterDelete.bounds.min[0]), 40)

  // ---- extract ----
  const only = extractShell(mesh, ids, 1)
  check('extract takes just that part', only.triangleCount, 12)
  check('positioned where it was', round(only.bounds.min[0]), 40)

  // ---- scale ----
  const scaled = scalePart(mesh, ids, 0, [2, 2, 2])
  check('scaling one part leaves the count alone', scaled.triangleCount, 24)
  check('the scaled part doubled', round(scaled.bounds.size[2]), 20)
  check('about its own centre', round(scaled.bounds.min[2]), -5)
  check('the other part did not move', round(scaled.bounds.max[0]), 50)
  check('and both are still solid', analyseMesh(scaled).watertight, true)

  // ---- rotate ----
  // A 10 x 20 x 30 box turned a quarter turn about Z should read 20 x 10 x 30.
  const boxFaces = cubeTriangles(1).map((face) =>
    face.map((value, i) => value * [10, 20, 30][i % 3]!),
  )
  const box = pipeline(boxFaces)
  const turned = rotatePart(box.mesh, new Uint32Array(box.mesh.triangleCount), null, 2, 90)
  check('a quarter turn swaps X and Y', [round(turned.bounds.size[0]), round(turned.bounds.size[1])], [20, 10])
  check('and leaves Z alone', round(turned.bounds.size[2]), 30)
  check('rotation keeps it solid', analyseMesh(turned).watertight, true)
  check('and keeps it facing out', analyseMesh(turned).shells[0]!.signedVolume > 0, true)

  // ---- concat ----
  const joined = concatMeshes(extractShell(mesh, ids, 0), extractShell(mesh, ids, 1))
  check('concat keeps both parts apart', analyseMesh(joined).shells.length, 2)
}

console.log('\nediting: cutting along a plane')
{
  const { mesh } = pipeline(cubeTriangles(10))
  const zPlane = { normal: [0, 0, 1] as [number, number, number], offset: 5 }

  const both = cutMesh(mesh, zPlane, 'both', DEFAULT_SETTINGS.weldEpsilon)
  const bothAnalysis = analyseMesh(both.mesh)
  check('the plane split 8 side triangles', both.splitTriangles, 8)
  // Each of the four walls is two triangles, so the cut crosses eight of them
  // and the square hole comes back as an eight-point loop — four corners plus
  // the four places the plane crossed a wall's diagonal. Ear clipping an
  // eight-gon is six triangles, and there are two faces to close.
  check('both faces were capped', both.capTriangles, 12)
  check('one cube became two parts', bothAnalysis.shells.length, 2)
  check('both parts are watertight', bothAnalysis.watertight, true)
  check('no boundary left open', bothAnalysis.boundaryEdges.length, 0)
  check('no non-manifold edges', bothAnalysis.nonManifoldEdges.length, 0)
  check('the pair still spans the original', both.mesh.bounds.size.map(round), [10, 10, 10])
  // Two 10 x 10 x 5 halves: 500 each, 1000 together, same as the whole cube.
  check(
    'and encloses the same volume',
    round(bothAnalysis.shells.reduce((sum, s) => sum + s.signedVolume, 0)),
    1000,
  )
  check('each half facing out', bothAnalysis.shells.every((s) => s.signedVolume > 0), true)

  const top = cutMesh(mesh, zPlane, 'front', DEFAULT_SETTINGS.weldEpsilon)
  const topAnalysis = analyseMesh(top.mesh)
  check('keeping the front gives one part', topAnalysis.shells.length, 1)
  check('watertight', topAnalysis.watertight, true)
  check('half as tall', round(top.mesh.bounds.size[2]), 5)
  check('and it is the top half', [round(top.mesh.bounds.min[2]), round(top.mesh.bounds.max[2])], [5, 10])

  const bottom = cutMesh(mesh, zPlane, 'back', DEFAULT_SETTINGS.weldEpsilon)
  check('keeping the back gives the other half', round(bottom.mesh.bounds.max[2]), 5)
  check('also watertight', analyseMesh(bottom.mesh).watertight, true)

  // A diagonal plane through the middle: the whole point of drawing the line
  // rather than sliding an axis.
  const diagonal = {
    normal: [Math.SQRT1_2, 0, Math.SQRT1_2] as [number, number, number],
    offset: Math.SQRT1_2 * 10,
  }
  const sliced = cutMesh(mesh, diagonal, 'both', DEFAULT_SETTINGS.weldEpsilon)
  const slicedAnalysis = analyseMesh(sliced.mesh)
  check('a diagonal cut also makes two parts', slicedAnalysis.shells.length, 2)
  check('both watertight', slicedAnalysis.watertight, true)
  check(
    'and conserves the volume',
    round(slicedAnalysis.shells.reduce((sum, s) => sum + s.signedVolume, 0)),
    1000,
  )

  // A plane that misses entirely must not claim to have cut anything.
  const missed = cutMesh(mesh, { normal: [0, 0, 1], offset: 50 }, 'both', DEFAULT_SETTINGS.weldEpsilon)
  check('a plane that misses splits nothing', missed.splitTriangles, 0)
  check('and caps nothing', missed.capTriangles, 0)
  check('leaving the mesh whole', analyseMesh(missed.mesh).shells.length, 1)

  // Cutting one part of a two-part model leaves the other untouched.
  const pair = pipeline([
    ...cubeTriangles(10),
    ...cubeTriangles(10).map((face) => face.map((v, i) => (i % 3 === 0 ? v + 40 : v))),
  ])
  const pairIds = new Uint32Array(pair.mesh.triangleCount)
  pair.analysis.shells.forEach((shell, index) => {
    for (const t of shell.triangles) pairIds[t] = index
  })
  const oneCut = cutPart(pair.mesh, pairIds, 0, zPlane, 'both', DEFAULT_SETTINGS.weldEpsilon)
  const oneCutAnalysis = analyseMesh(oneCut.mesh)
  check('cutting one part of two gives three', oneCutAnalysis.shells.length, 3)
  check('all still watertight', oneCutAnalysis.watertight, true)
}


console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
