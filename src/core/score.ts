import type { Analysis, IndexedMesh, Score, ScoreComponent, Settings } from './types'

/** Spec §12 flags these as needing real-world tuning, so they live in one
 *  named table rather than scattered through the scoring code. Weights are
 *  relative; the total is normalised by their sum. */
export const SCORE_WEIGHTS = {
  /** Heaviest by a wide margin — §5.4 calls for a large penalty on failure. */
  watertight: 45,
  overhangs: 18,
  wallThickness: 15,
  islands: 12,
  buildVolume: 10,
} as const

/** How many faces to sample when measuring wall thickness. Full ray-casting
 *  over every face is quadratic-ish and pointless — thin walls are regional,
 *  and a few thousand samples finds them. */
const THICKNESS_SAMPLES = 2500

function faceNormal(mesh: IndexedMesh, t: number): [number, number, number] {
  const { positions: p, indices } = mesh
  const a = indices[t * 3]!, b = indices[t * 3 + 1]!, c = indices[t * 3 + 2]!
  const ax = p[a * 3]!, ay = p[a * 3 + 1]!, az = p[a * 3 + 2]!
  const bx = p[b * 3]! - ax, by = p[b * 3 + 1]! - ay, bz = p[b * 3 + 2]! - az
  const cx = p[c * 3]! - ax, cy = p[c * 3 + 1]! - ay, cz = p[c * 3 + 2]! - az
  const nx = by * cz - bz * cy
  const ny = bz * cx - bx * cz
  const nz = bx * cy - by * cx
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}

function faceCentroid(mesh: IndexedMesh, t: number): [number, number, number] {
  const { positions: p, indices } = mesh
  const a = indices[t * 3]!, b = indices[t * 3 + 1]!, c = indices[t * 3 + 2]!
  return [
    (p[a * 3]! + p[b * 3]! + p[c * 3]!) / 3,
    (p[a * 3 + 1]! + p[b * 3 + 1]! + p[c * 3 + 1]!) / 3,
    (p[a * 3 + 2]! + p[b * 3 + 2]! + p[c * 3 + 2]!) / 3,
  ]
}

/** Möller–Trumbore, single-sided disabled so we hit back faces too — when
 *  measuring wall thickness the far surface is exactly what we want. */
function rayTriangle(
  mesh: IndexedMesh, t: number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
): number | null {
  const { positions: p, indices } = mesh
  const a = indices[t * 3]!, b = indices[t * 3 + 1]!, c = indices[t * 3 + 2]!
  const ax = p[a * 3]!, ay = p[a * 3 + 1]!, az = p[a * 3 + 2]!
  const e1x = p[b * 3]! - ax, e1y = p[b * 3 + 1]! - ay, e1z = p[b * 3 + 2]! - az
  const e2x = p[c * 3]! - ax, e2y = p[c * 3 + 1]! - ay, e2z = p[c * 3 + 2]! - az

  const hx = dy * e2z - dz * e2y
  const hy = dz * e2x - dx * e2z
  const hz = dx * e2y - dy * e2x
  const det = e1x * hx + e1y * hy + e1z * hz
  if (Math.abs(det) < 1e-12) return null

  const invDet = 1 / det
  const sx = ox - ax, sy = oy - ay, sz = oz - az
  const u = (sx * hx + sy * hy + sz * hz) * invDet
  if (u < 0 || u > 1) return null

  const qx = sy * e1z - sz * e1y
  const qy = sz * e1x - sx * e1z
  const qz = sx * e1y - sy * e1x
  const v = (dx * qx + dy * qy + dz * qz) * invDet
  if (v < 0 || u + v > 1) return null

  const distance = (e2x * qx + e2y * qy + e2z * qz) * invDet
  return distance > 1e-9 ? distance : null
}

/** Measure wall thickness by firing each sampled face's normal back into the
 *  solid and recording how far it travels before leaving again (spec §5.4).
 *
 *  Brute force over every candidate face would be far too slow, so rays are
 *  restricted to the Z-slab they start in — the same bucketing the slice
 *  viewer uses. It can miss a wall that runs steeply through many slabs,
 *  which is an acceptable trade for keeping the whole score interactive. */
function measureThinWalls(
  mesh: IndexedMesh,
  zBuckets: Uint32Array[],
  threshold: number,
): { thin: number; sampled: number; minimum: number } {
  const { triangleCount, bounds } = mesh
  const step = Math.max(1, Math.floor(triangleCount / THICKNESS_SAMPLES))
  const spanZ = bounds.size[2] || 1
  const bucketCount = zBuckets.length

  let thin = 0
  let sampled = 0
  let minimum = Infinity

  for (let t = 0; t < triangleCount; t += step) {
    const [nx, ny, nz] = faceNormal(mesh, t)
    const [cx, cy, cz] = faceCentroid(mesh, t)
    // Start a hair inside the surface so we do not re-hit the origin face.
    const ox = cx - nx * 1e-5, oy = cy - ny * 1e-5, oz = cz - nz * 1e-5

    const bucket = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor(((cz - bounds.min[2]) / spanZ) * bucketCount)),
    )
    const candidates = zBuckets[bucket]
    if (!candidates) continue

    let nearest = Infinity
    for (const other of candidates) {
      if (other === t) continue
      const hit = rayTriangle(mesh, other, ox, oy, oz, -nx, -ny, -nz)
      if (hit !== null && hit < nearest) nearest = hit
    }

    if (nearest !== Infinity) {
      sampled++
      if (nearest < minimum) minimum = nearest
      if (nearest < threshold) thin++
    }
  }

  return { thin, sampled, minimum: minimum === Infinity ? 0 : minimum }
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export function scoreMesh(
  mesh: IndexedMesh,
  analysis: Analysis,
  zBuckets: Uint32Array[],
  settings: Settings,
): Score {
  const components: ScoreComponent[] = []
  const { bounds, triangleCount } = mesh

  // --- Watertight / manifold ------------------------------------------
  const badEdges = analysis.boundaryEdges.length + analysis.nonManifoldEdges.length
  const watertightRatio = analysis.watertight ? 1 : clamp01(1 - badEdges / Math.max(1, triangleCount * 0.02))
  components.push({
    label: 'Watertight & manifold',
    ratio: watertightRatio,
    weight: SCORE_WEIGHTS.watertight,
    note: analysis.watertight
      ? 'Closed solid — your slicer knows exactly what is inside.'
      : `${badEdges} bad ${badEdges === 1 ? 'edge' : 'edges'}. The slicer has to guess at the interior here.`,
    help: analysis.watertight
      ? 'Nothing to do here.'
      : 'Close the open boundaries in your modeller, or run a mesh repair pass, then load it again.',
    status: analysis.watertight ? 'pass' : 'fail',
  })

  // --- Overhangs -------------------------------------------------------
  // Angle is measured from the build plate normal (+Z). A face steeper than
  // the threshold needs support; how much area is affected is what matters.
  const cosLimit = Math.cos(((90 + settings.overhangThreshold) * Math.PI) / 180)
  let overhangFaces = 0
  for (let t = 0; t < triangleCount; t++) {
    if (faceNormal(mesh, t)[2] < cosLimit) overhangFaces++
  }
  const overhangShare = triangleCount === 0 ? 0 : overhangFaces / triangleCount
  components.push({
    label: `Overhangs > ${settings.overhangThreshold}°`,
    ratio: clamp01(1 - overhangShare * 3),
    weight: SCORE_WEIGHTS.overhangs,
    note: overhangFaces === 0
      ? 'Nothing needs support.'
      : `${overhangFaces.toLocaleString()} faces (${(overhangShare * 100).toFixed(1)}%) will need support.`,
    help:
      overhangFaces === 0
        ? 'Nothing to do here.'
        : 'Try rotating the part so fewer faces lean past the threshold, or turn supports on for this print.',
    status: overhangShare < 0.05 ? 'pass' : overhangShare < 0.2 ? 'warn' : 'fail',
  })

  // --- Wall thickness ---------------------------------------------------
  const minWall = settings.nozzleDiameter * 2
  const walls = measureThinWalls(mesh, zBuckets, minWall)
  const thinShare = walls.sampled === 0 ? 0 : walls.thin / walls.sampled
  components.push({
    label: 'Wall thickness',
    ratio: clamp01(1 - thinShare * 4),
    weight: SCORE_WEIGHTS.wallThickness,
    note: walls.sampled === 0
      ? 'Not enough closed geometry to sample.'
      : walls.thin === 0
        ? `Thinnest sampled wall ${fmt(walls.minimum)} mm — clears a ${fmt(settings.nozzleDiameter)} mm nozzle.`
        : `${(thinShare * 100).toFixed(1)}% of samples are thinner than two nozzle widths; thinnest was ${fmt(walls.minimum)} mm.`,
    help:
      walls.thin === 0
        ? 'Nothing to do here.'
        : `Thicken those walls past ${fmt(minWall)} mm, or fit a narrower nozzle and tell Meshlight in Setup.`,
    status: thinShare < 0.02 ? 'pass' : thinShare < 0.1 ? 'warn' : 'fail',
  })

  // --- Floating islands -------------------------------------------------
  // A shell whose lowest point sits clearly above the model's own base has
  // nothing under it to print onto.
  const baseZ = bounds.min[2]
  const floatTolerance = Math.max(bounds.size[2] * 0.01, settings.nozzleDiameter)
  const floating = analysis.shells.filter((s) => s.bounds.min[2] > baseZ + floatTolerance)
  components.push({
    label: 'Unsupported islands',
    ratio: analysis.shells.length === 0 ? 1 : clamp01(1 - floating.length / analysis.shells.length),
    weight: SCORE_WEIGHTS.islands,
    note: floating.length === 0
      ? 'Every shell reaches the plate.'
      : `${floating.length} of ${analysis.shells.length} shells start above the plate and will print into thin air.`,
    help:
      floating.length === 0
        ? 'Nothing to do here.'
        : 'Open Cutaway to find them, then either rest them on the plate or print with supports.',
    status: floating.length === 0 ? 'pass' : 'fail',
  })

  // --- Build volume -----------------------------------------------------
  // Try the part both ways round on the plate before calling it too big.
  const [bx, by, bz] = settings.buildVolume
  const [sx, sy, sz] = bounds.size
  const fitsUpright = sx <= bx && sy <= by && sz <= bz
  const fitsRotated = sy <= bx && sx <= by && sz <= bz
  const fits = fitsUpright || fitsRotated
  const worstAxis = Math.max(sx / bx, sy / by, sz / bz)
  components.push({
    label: 'Fits build volume',
    ratio: fits ? 1 : clamp01(1 - (worstAxis - 1)),
    weight: SCORE_WEIGHTS.buildVolume,
    note: fits
      ? `${fmt(sx)} × ${fmt(sy)} × ${fmt(sz)} mm on a ${bx} × ${by} × ${bz} mm plate.`
      : `${fmt(sx)} × ${fmt(sy)} × ${fmt(sz)} mm is larger than your ${bx} × ${by} × ${bz} mm plate.`,
    help: fits
      ? 'Nothing to do here.'
      : 'Scale it down, split it into parts, or set your real build volume in Setup.',
    status: fits ? 'pass' : 'fail',
  })

  const weightTotal = components.reduce((sum, c) => sum + c.weight, 0)
  const total = Math.round(
    components.reduce((sum, c) => sum + c.ratio * c.weight, 0) / weightTotal * 100,
  )

  return { total, verdict: verdictFor(total), components }
}

function verdictFor(total: number): string {
  if (total >= 90) return 'Ready to print'
  if (total >= 70) return 'Good, with minor notes'
  if (total >= 50) return 'Printable, with caveats'
  if (total >= 30) return 'Needs work before printing'
  return 'Not printable as-is'
}
