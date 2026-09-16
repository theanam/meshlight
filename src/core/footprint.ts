/** The smallest rectangle that encloses a part's footprint, and how far it is
 *  turned from the world axes.
 *
 *  An axis-aligned box measures the axes, not the part. Lay a 200 × 30 mm bar
 *  across the plate at 45° and it reports 155 × 155 — true of the extents,
 *  useless as a measurement of the bar, and wrong about whether it fits.
 *
 *  Only the footprint is rotated. Z stays vertical because it is not an
 *  arbitrary axis: it is the direction the printer builds in, so the height of
 *  a part is the height of a part however it is turned on the bed. */
export interface Footprint {
  /** Rotation of the rectangle about Z, in radians, in [0, π/2). */
  angle: number
  /** Extent along the rectangle's own X axis. */
  width: number
  /** Extent along its own Y axis. */
  depth: number
  /** Centre of the rectangle, in world XY. */
  center: [number, number]
}

/** The full-mesh hull, kept per positions buffer.
 *
 *  Scoring and the readiness checks both ask about the same footprint, and
 *  both re-run whenever a setting changes. The buffer is stable for the life
 *  of a loaded mesh, so the hull is worth computing once rather than four
 *  times per settings keystroke. */
const fullHulls = new WeakMap<Float32Array, number[]>()

function hullFor(points: Float32Array, indices: Uint32Array | null): number[] {
  if (indices) return convexHullXY(points, indices)
  const cached = fullHulls.get(points)
  if (cached) return cached
  const all = new Uint32Array(points.length / 3)
  for (let v = 0; v < all.length; v++) all[v] = v
  const hull = convexHullXY(points, all)
  fullHulls.set(points, hull)
  return hull
}

/** Extents of the hull measured in a frame turned by `angle`. */
function extentsAt(points: Float32Array, hull: number[], angle: number): [number, number] {
  const ux = Math.cos(angle)
  const uy = Math.sin(angle)
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
  for (const h of hull) {
    const x = points[h * 3]!
    const y = points[h * 3 + 1]!
    const u = x * ux + y * uy
    const v = -x * uy + y * ux
    if (u < minU) minU = u
    if (u > maxU) maxU = u
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }
  return [maxU - minU, maxV - minV]
}

/** Andrew's monotone chain, over an index list so the points never leave the
 *  typed array they came in. Returns hull vertex indices counter-clockwise. */
function convexHullXY(points: Float32Array, indices: Uint32Array): number[] {
  const order = [...indices].sort((a, b) => {
    const ax = points[a * 3]!, bx = points[b * 3]!
    return ax === bx ? points[a * 3 + 1]! - points[b * 3 + 1]! : ax - bx
  })

  const cross = (o: number, a: number, b: number): number =>
    (points[a * 3]! - points[o * 3]!) * (points[b * 3 + 1]! - points[o * 3 + 1]!) -
    (points[a * 3 + 1]! - points[o * 3 + 1]!) * (points[b * 3]! - points[o * 3]!)

  const build = (seq: number[]): number[] => {
    const chain: number[] = []
    for (const p of seq) {
      // <= 0 drops collinear points, which the calipers below do not need and
      // which only make the edge loop longer.
      while (chain.length >= 2 && cross(chain[chain.length - 2]!, chain[chain.length - 1]!, p) <= 0) {
        chain.pop()
      }
      chain.push(p)
    }
    chain.pop()
    return chain
  }

  const hull = build(order).concat(build([...order].reverse()))
  return hull.length >= 3 ? hull : order
}

/** Rotating calipers. The minimal-area enclosing rectangle always has a side
 *  lying along a hull edge, so trying each edge in turn is exhaustive rather
 *  than a search — there is no angle between two edges that could do better. */
export function orientedFootprint(
  points: Float32Array,
  /** Which vertices to measure, or null for every vertex — which is cached. */
  indices: Uint32Array | null,
): Footprint | null {
  if (indices !== null && indices.length === 0) return null
  if (points.length === 0) return null
  const hull = hullFor(points, indices)
  if (hull.length < 2) return null

  let best: Footprint | null = null

  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!
    const b = hull[(i + 1) % hull.length]!
    const ex = points[b * 3]! - points[a * 3]!
    const ey = points[b * 3 + 1]! - points[a * 3 + 1]!
    const len = Math.hypot(ex, ey)
    if (len < 1e-9) continue

    // Unit vectors of the frame this edge defines.
    const ux = ex / len, uy = ey / len
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
    for (const h of hull) {
      const x = points[h * 3]!, y = points[h * 3 + 1]!
      const u = x * ux + y * uy
      const v = -x * uy + y * ux
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }

    const width = maxU - minU
    const depth = maxV - minV
    if (best !== null && width * depth >= best.width * best.depth) continue

    // Back to world: the centre is in the rotated frame, so it rotates out.
    const cu = (minU + maxU) / 2
    const cv = (minV + maxV) / 2
    best = {
      angle: Math.atan2(uy, ux),
      width,
      depth,
      center: [cu * ux - cv * uy, cu * uy + cv * ux],
    }
  }

  if (!best) return null

  // A rectangle is the same rectangle every quarter turn, so fold the angle
  // into [0, π/2) and swap the sides to match. Without this an axis-aligned
  // part can come back "rotated 90°", which is true and useless.
  let { angle, width, depth } = best
  const quarter = Math.PI / 2
  angle = ((angle % quarter) + quarter) % quarter
  if (best.angle !== angle && Math.abs(Math.cos(best.angle - angle)) < 0.5) {
    ;[width, depth] = [depth, width]
  }
  return { angle, width, depth, center: best.center }
}

/** Whether the part fits a bed of bedX x bedY, given that you are free to turn
 *  it about Z before printing.
 *
 *  Not the same question as the minimal-area rectangle. Smallest is not the
 *  same as fits: a longer, narrower orientation can drop onto a bed that the
 *  tightest box overruns, because a bed has an aspect ratio of its own.
 *
 *  Every orientation worth trying is one where a hull edge lies parallel to a
 *  bed side, so the candidate list is the hull's own edge directions and their
 *  quarter turns, plus square-on. That is the whole search, not a sample. */
export interface PlateFit {
  fits: boolean
  /** Rotation about Z to apply, in radians, in [0, π). Zero when it already
   *  fits as it stands. */
  angle: number
  /** Footprint along the bed's X at that rotation. */
  width: number
  /** Footprint along the bed's Y at that rotation. */
  depth: number
  /** How far it still overruns the bed at its best orientation, in mm. */
  overflow: number
}

export function plateFit(points: Float32Array, bedX: number, bedY: number): PlateFit | null {
  if (points.length === 0) return null
  const hull = hullFor(points, null)
  if (hull.length === 0) return null

  const half = Math.PI / 2
  const angles = [0]
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!
    const b = hull[(i + 1) % hull.length]!
    const ex = points[b * 3]! - points[a * 3]!
    const ey = points[b * 3 + 1]! - points[a * 3 + 1]!
    if (Math.hypot(ex, ey) < 1e-9) continue
    const edge = Math.atan2(ey, ex)
    angles.push(edge, edge + half)
  }

  let best: PlateFit | null = null
  for (const angle of angles) {
    const [width, depth] = extentsAt(points, hull, angle)
    const overflow = Math.max(0, width - bedX, depth - bedY)
    // Ties go to the smaller turn, so a part that fits as it stands is never
    // told to rotate for nothing.
    const turn = ((angle % Math.PI) + Math.PI) % Math.PI
    if (best && (overflow > best.overflow || (overflow === best.overflow && turn >= best.angle))) {
      continue
    }
    best = { fits: overflow <= 0, angle: turn, width, depth, overflow }
  }
  return best
}
