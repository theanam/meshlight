/** A stand-in part for development, built in code rather than shipped as a
 *  binary so it costs the production bundle nothing.
 *
 *  This module is only ever reached from behind an `import.meta.env.DEV`
 *  guard, which Vite evaluates to `false` at build time — the branch and this
 *  whole chunk are then dropped, so a release always opens on the drop screen.
 *
 *  The part deliberately carries the defects the report is meant to catch:
 *  an open boundary, a reversed face, and a shell floating off the plate.
 *  It also has a tessellated cylinder, so flat shading and feature edges have
 *  something curved to prove themselves against. */

type Tri = [number, number, number][]

const v = (x: number, y: number, z: number): [number, number, number] => [x, y, z]

function quad(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
): Tri[] {
  return [
    [a, b, c],
    [a, c, d],
  ]
}

function box(ox: number, oy: number, oz: number, sx: number, sy: number, sz: number): Tri[] {
  const p = [
    v(ox, oy, oz), v(ox + sx, oy, oz), v(ox + sx, oy + sy, oz), v(ox, oy + sy, oz),
    v(ox, oy, oz + sz), v(ox + sx, oy, oz + sz), v(ox + sx, oy + sy, oz + sz), v(ox, oy + sy, oz + sz),
  ] as [number, number, number][]
  return [
    ...quad(p[0]!, p[3]!, p[2]!, p[1]!), // bottom
    ...quad(p[4]!, p[5]!, p[6]!, p[7]!), // top
    ...quad(p[0]!, p[1]!, p[5]!, p[4]!),
    ...quad(p[1]!, p[2]!, p[6]!, p[5]!),
    ...quad(p[2]!, p[3]!, p[7]!, p[6]!),
    ...quad(p[3]!, p[0]!, p[4]!, p[7]!),
  ]
}

/** Closed cylinder, capped at both ends, wound outward. */
function cylinder(cx: number, cy: number, z0: number, z1: number, radius: number, segments: number): Tri[] {
  const out: Tri[] = []
  const ring = (z: number) =>
    Array.from({ length: segments }, (_, i) => {
      const a = (i / segments) * Math.PI * 2
      return v(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, z)
    })
  const lower = ring(z0)
  const upper = ring(z1)
  const centreLow = v(cx, cy, z0)
  const centreHigh = v(cx, cy, z1)

  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments
    out.push(...quad(lower[i]!, lower[j]!, upper[j]!, upper[i]!))
    out.push([centreLow, lower[j]!, lower[i]!])
    out.push([centreHigh, upper[i]!, upper[j]!])
  }
  return out
}

function toBinaryStl(faces: Tri[]): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + faces.length * 50)
  const view = new DataView(buffer)
  view.setUint32(80, faces.length, true)
  let offset = 84
  for (const face of faces) {
    // Normals left at zero; Meshlight recomputes from winding regardless.
    for (let corner = 0; corner < 3; corner++) {
      for (let axis = 0; axis < 3; axis++) {
        view.setFloat32(offset + 12 + corner * 12 + axis * 4, face[corner]![axis]!, true)
      }
    }
    offset += 50
  }
  return buffer
}

export const SAMPLE_NAME = 'sample-bracket.stl'

export function sampleStl(): ArrayBuffer {
  const faces: Tri[] = [
    ...box(0, 0, 0, 80, 60, 8),           // base plate
    ...cylinder(40, 30, 8, 46, 14, 32),   // boss
    ...box(4, 26, 8, 72, 8, 22),          // rib
  ]

  // Defect 1: drop a face from the rib, leaving an open boundary.
  faces.splice(faces.length - 1, 1)

  // Defect 2: reverse one face of the plate so its normal points inward.
  const flip = 6
  const f = faces[flip]!
  faces[flip] = [f[0]!, f[2]!, f[1]!]

  // Defect 3: a small shell floating clear of the build plate.
  faces.push(...box(62, 6, 30, 10, 10, 10))

  return toBinaryStl(faces)
}
