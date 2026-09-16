/** Triangulating a closed loop of 3D points that is nearly, but not exactly,
 *  planar.
 *
 *  Two callers want this and they want it to behave identically: repair closes
 *  a boundary loop with a patch, and the cut tool caps the face it opens. If
 *  they each grew their own ear clipper the two would drift, and a mesh cut
 *  then repaired would be triangulated two different ways. */

export type Vec3 = [number, number, number]

/** Newell's method: a stable normal for a polygon that is not exactly flat. */
export function loopNormal(positions: Float32Array, loop: number[]): Vec3 {
  let nx = 0, ny = 0, nz = 0
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!, b = loop[(i + 1) % loop.length]!
    const ax = positions[a * 3]!, ay = positions[a * 3 + 1]!, az = positions[a * 3 + 2]!
    const bx = positions[b * 3]!, by = positions[b * 3 + 1]!, bz = positions[b * 3 + 2]!
    nx += (ay - by) * (az + bz)
    ny += (az - bz) * (ax + bx)
    nz += (ax - bx) * (ay + by)
  }
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}

/** Two unit vectors spanning the plane with this normal. Which pair we get is
 *  arbitrary but deterministic, which is all the ear clipper needs. */
export function planeBasis(normal: Vec3): [Vec3, Vec3] {
  const up: Vec3 = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  const ux = up[1] * normal[2] - up[2] * normal[1]
  const uy = up[2] * normal[0] - up[0] * normal[2]
  const uz = up[0] * normal[1] - up[1] * normal[0]
  const ulen = Math.hypot(ux, uy, uz) || 1
  const u: Vec3 = [ux / ulen, uy / ulen, uz / ulen]
  const v: Vec3 = [
    normal[1] * u[2] - normal[2] * u[1],
    normal[2] * u[0] - normal[0] * u[2],
    normal[0] * u[1] - normal[1] * u[0],
  ]
  return [u, v]
}

/** Ear-clip a loop, working in the loop's own best-fit plane.
 *
 *  Ear clipping keeps every original vertex and adds none, which matters for
 *  both callers: a repair patch meets the surrounding surface exactly, and a
 *  cut cap meets the wall it was sliced from exactly. Returns null if the loop
 *  is too twisted to clip, so the caller can fall back to a centroid fan. */
export function earClip(positions: Float32Array, loop: number[]): number[][] | null {
  const n = loop.length
  if (n < 3) return null
  if (n === 3) return [[loop[0]!, loop[1]!, loop[2]!]]

  const normal = loopNormal(positions, loop)
  const [u, v] = planeBasis(normal)

  const flat = loop.map((index) => {
    const x = positions[index * 3]!, y = positions[index * 3 + 1]!, z = positions[index * 3 + 2]!
    return [x * u[0] + y * u[1] + z * u[2], x * v[0] + y * v[1] + z * v[2]] as [number, number]
  })

  const area2 = (a: [number, number], b: [number, number], c: [number, number]): number =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

  const inside = (
    a: [number, number], b: [number, number], c: [number, number], p: [number, number],
  ): boolean => {
    const d1 = area2(a, b, p), d2 = area2(b, c, p), d3 = area2(c, a, p)
    const negative = d1 < 0 || d2 < 0 || d3 < 0
    const positive = d1 > 0 || d2 > 0 || d3 > 0
    return !(negative && positive)
  }

  const remaining = loop.map((_, i) => i)
  const out: number[][] = []
  let guard = n * n

  while (remaining.length > 3 && guard-- > 0) {
    let clipped = false
    for (let i = 0; i < remaining.length; i++) {
      const ia = remaining[(i + remaining.length - 1) % remaining.length]!
      const ib = remaining[i]!
      const ic = remaining[(i + 1) % remaining.length]!
      const a = flat[ia]!, b = flat[ib]!, c = flat[ic]!
      if (area2(a, b, c) <= 0) continue // reflex or collinear in this winding

      let blocked = false
      for (const other of remaining) {
        if (other === ia || other === ib || other === ic) continue
        if (inside(a, b, c, flat[other]!)) { blocked = true; break }
      }
      if (blocked) continue

      out.push([loop[ia]!, loop[ib]!, loop[ic]!])
      remaining.splice(i, 1)
      clipped = true
      break
    }
    if (!clipped) return null // twisted loop — let the caller fan it instead
  }

  if (remaining.length === 3) {
    out.push([loop[remaining[0]!]!, loop[remaining[1]!]!, loop[remaining[2]!]!])
  }
  return out
}
