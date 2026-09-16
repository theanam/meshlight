import { measureThinWalls } from './score'
import type { Analysis, IndexedMesh, Settings } from './types'

/** One practical question about getting this part off the printer.
 *
 *  Deliberately not a score. The score answers "how good is this mesh"; these
 *  answer "what will happen when I press print", which is a different question
 *  with different answers — a watertight, perfectly wound model can still be
 *  unprintable because it is 0.2 mm thick or balanced on a corner. */
export interface ReadinessCheck {
  id: string
  title: string
  /** What was measured. Numbers only — no advice in here. */
  finding: string
  /** What to do about it. */
  advice: string
  /** The headline figure, set in mono beside the title. */
  metric: string
  status: 'pass' | 'warn' | 'fail'
}

export interface Readiness {
  checks: ReadinessCheck[]
  /** One line summarising the lot, for the top of the section. */
  verdict: string
}

/** Fewer rays than the score's own pass: this one is looking for the single
 *  thinnest feature rather than measuring a distribution, and the minimum
 *  settles long before the last sample. */
const DETAIL_SAMPLES = 1200

/** Below this, a flat-on-the-bed footprint is small enough that a tall part
 *  can pop off mid-print. Roughly a 1 cm square. */
const SMALL_FOOTPRINT_MM2 = 100

/** Height-to-narrowest-footprint ratio past which a part starts to wobble as
 *  the head changes direction. */
const TIPPY_ASPECT = 6

/** Normal and area from one cross product, because every caller here wants
 *  both and the cross product is the expensive half. */
function faceNormalArea(mesh: IndexedMesh, t: number): [number, number, number, number] {
  const { positions: p, indices } = mesh
  const a = indices[t * 3]!, b = indices[t * 3 + 1]!, c = indices[t * 3 + 2]!
  const ax = p[a * 3]!, ay = p[a * 3 + 1]!, az = p[a * 3 + 2]!
  const bx = p[b * 3]! - ax, by = p[b * 3 + 1]! - ay, bz = p[b * 3 + 2]! - az
  const cx = p[c * 3]! - ax, cy = p[c * 3 + 1]! - ay, cz = p[c * 3 + 2]! - az
  const nx = by * cz - bz * cy
  const ny = bz * cx - bx * cz
  const nz = bx * cy - by * cx
  const len = Math.hypot(nx, ny, nz)
  if (len === 0) return [0, 0, 0, 0]
  return [nx / len, ny / len, nz / len, len / 2]
}

function mm(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export function assessReadiness(
  mesh: IndexedMesh,
  analysis: Analysis,
  zBuckets: Uint32Array[],
  settings: Settings,
): Readiness {
  const checks: ReadinessCheck[] = []
  const { bounds, triangleCount } = mesh
  const nozzle = settings.nozzleDiameter
  const [sx, sy, sz] = bounds.size

  // --- Fine detail ------------------------------------------------------
  // A feature narrower than the nozzle is not thin, it is absent: the slicer
  // has no extrusion width small enough to put there, so it silently vanishes.
  const walls = measureThinWalls(mesh, zBuckets, nozzle, DETAIL_SAMPLES)
  if (walls.sampled === 0) {
    checks.push({
      id: 'detail',
      title: 'Fine detail',
      metric: '—',
      finding: 'Not enough closed geometry to measure feature size.',
      advice: 'Close the mesh first; thickness cannot be measured through an open surface.',
      status: 'warn',
    })
  } else if (walls.thin > 0) {
    checks.push({
      id: 'detail',
      title: 'Fine detail',
      metric: `${mm(walls.minimum)} mm`,
      finding: `${walls.thin} of ${walls.sampled} sampled features are thinner than the ${mm(nozzle)} mm nozzle — the thinnest is ${mm(walls.minimum)} mm.`,
      advice: `Nothing narrower than one nozzle width gets extruded, so those details will come out as gaps rather than thin walls. Thicken them past ${mm(nozzle)} mm, or fit a narrower nozzle and set it in Setup.`,
      status: 'fail',
    })
  } else if (walls.minimum < nozzle * 2) {
    checks.push({
      id: 'detail',
      title: 'Fine detail',
      metric: `${mm(walls.minimum)} mm`,
      finding: `Thinnest feature is ${mm(walls.minimum)} mm — one extrusion wide on a ${mm(nozzle)} mm nozzle.`,
      advice: `It will print, as a single unsupported wall with no infill behind it. Expect it to be fragile; past ${mm(nozzle * 2)} mm you get two walls and a real bond between them.`,
      status: 'warn',
    })
  } else {
    checks.push({
      id: 'detail',
      title: 'Fine detail',
      metric: `${mm(walls.minimum)} mm`,
      finding: `Thinnest feature is ${mm(walls.minimum)} mm, comfortably over the ${mm(nozzle)} mm nozzle.`,
      advice: 'Every feature is wide enough to reproduce.',
      status: 'pass',
    })
  }

  // --- Supports ---------------------------------------------------------
  // Weighted by area, not by face count: a single huge downward face matters
  // more than a thousand tiny ones on a tessellated curve.
  const cosLimit = Math.cos(((90 + settings.overhangThreshold) * Math.PI) / 180)
  const epsilon = Math.max(sz * 0.001, 1e-4)
  const baseZ = bounds.min[2]
  let totalArea = 0
  let overhangArea = 0
  let contactArea = 0
  let contactMinX = Infinity, contactMaxX = -Infinity
  let contactMinY = Infinity, contactMaxY = -Infinity

  for (let t = 0; t < triangleCount; t++) {
    const [, , nz, area] = faceNormalArea(mesh, t)
    if (area === 0) continue
    totalArea += area

    // A face lying on the plate: every corner at the model's lowest Z, and
    // pointing down rather than being a vertical wall that happens to reach it.
    let onPlate = false
    if (nz < -0.7) {
      const { positions: p, indices } = mesh
      const a = indices[t * 3]!, b = indices[t * 3 + 1]!, c = indices[t * 3 + 2]!
      const az = p[a * 3 + 2]!, bz = p[b * 3 + 2]!, cz = p[c * 3 + 2]!
      if (az <= baseZ + epsilon && bz <= baseZ + epsilon && cz <= baseZ + epsilon) {
        onPlate = true
        contactArea += area
        for (const v of [a, b, c]) {
          const x = p[v * 3]!, y = p[v * 3 + 1]!
          if (x < contactMinX) contactMinX = x
          if (x > contactMaxX) contactMaxX = x
          if (y < contactMinY) contactMinY = y
          if (y > contactMaxY) contactMaxY = y
        }
      }
    }

    // The bottom of the part points straight down and so looks like the worst
    // overhang there is — but it is the first layer, printed onto the bed.
    // Counting it is how a flat-bottomed box ends up "28% needing support".
    if (!onPlate && nz < cosLimit) overhangArea += area
  }

  const overhangShare = totalArea === 0 ? 0 : overhangArea / totalArea
  checks.push({
    id: 'supports',
    title: 'Supports',
    metric: `${(overhangShare * 100).toFixed(1)}%`,
    finding:
      overhangShare === 0
        ? `Nothing leans past ${settings.overhangThreshold}°.`
        : `${(overhangShare * 100).toFixed(1)}% of the surface leans past ${settings.overhangThreshold}° from the plate.`,
    advice:
      overhangShare === 0
        ? 'Print it without supports.'
        : overhangShare < 0.02
          ? 'Small enough that most printers bridge it. Worth a test print before committing to supports.'
          : `Turn supports on, or rotate the part so fewer faces lean past ${settings.overhangThreshold}° — rotating is free, supports cost material and leave marks.`,
    status: overhangShare < 0.02 ? 'pass' : overhangShare < 0.15 ? 'warn' : 'fail',
  })

  // --- Bed adhesion -----------------------------------------------------
  const footprintX = contactArea > 0 ? contactMaxX - contactMinX : 0
  const footprintY = contactArea > 0 ? contactMaxY - contactMinY : 0
  if (contactArea === 0) {
    checks.push({
      id: 'adhesion',
      title: 'Bed adhesion',
      metric: '0 mm²',
      finding: 'No face lies flat on the plate — the part meets the bed on an edge, a point, or not at all.',
      advice: 'Rotate it so a face sits flat, or print it on a raft. A part balanced on an edge has almost nothing holding it down.',
      status: 'fail',
    })
  } else {
    const small = contactArea < SMALL_FOOTPRINT_MM2
    checks.push({
      id: 'adhesion',
      title: 'Bed adhesion',
      metric: `${contactArea.toFixed(0)} mm²`,
      finding: `${contactArea.toFixed(0)} mm² of the part lies flat on the plate, over a ${mm(footprintX)} × ${mm(footprintY)} mm area.`,
      advice: small
        ? 'That is a small area to hold a part down for a whole print. Add a brim, and make sure the first layer is well squashed.'
        : 'Enough contact to hold on its own.',
      status: small ? 'warn' : 'pass',
    })

    // --- Stability ------------------------------------------------------
    const narrowest = Math.max(Math.min(footprintX, footprintY), 1e-6)
    const aspect = sz / narrowest
    const tippy = aspect > TIPPY_ASPECT
    checks.push({
      id: 'stability',
      title: 'Stability',
      metric: `${aspect.toFixed(1)} : 1`,
      finding: `${mm(sz)} mm tall on a footprint ${mm(narrowest)} mm across at its narrowest.`,
      advice: tippy
        ? 'Tall and narrow. It will flex as the head changes direction, which shows up as ringing and can shear it off the bed. Slow the outer walls down, or lay it on its side and accept the supports.'
        : 'Squat enough to stay put while it prints.',
      status: tippy ? 'warn' : 'pass',
    })
  }

  // --- Plate fit --------------------------------------------------------
  const [bvx, bvy, bvz] = settings.buildVolume
  const fitsUpright = sx <= bvx && sy <= bvy && sz <= bvz
  const fitsRotated = sy <= bvx && sx <= bvy && sz <= bvz
  const size = `${mm(sx)} × ${mm(sy)} × ${mm(sz)} mm`
  if (fitsUpright) {
    checks.push({
      id: 'fit',
      title: 'Plate fit',
      metric: size,
      finding: `Fits your ${bvx} × ${bvy} × ${bvz} mm build volume as it stands.`,
      advice: 'Nothing to do here.',
      status: 'pass',
    })
  } else if (fitsRotated) {
    checks.push({
      id: 'fit',
      title: 'Plate fit',
      metric: size,
      finding: `Only fits your ${bvx} × ${bvy} × ${bvz} mm plate turned 90° about Z.`,
      advice: 'Rotate it in your slicer before you print, or it will be clipped at the edge.',
      status: 'warn',
    })
  } else {
    const over = Math.max(sx - bvx, sy - bvy, sz - bvz)
    const axis = sz - bvz === over ? 'Z' : sx - bvx === over ? 'X' : 'Y'
    checks.push({
      id: 'fit',
      title: 'Plate fit',
      metric: size,
      finding: `Overruns your ${bvx} × ${bvy} × ${bvz} mm build volume by ${mm(over)} mm on ${axis}, whichever way round it goes.`,
      advice: 'Scale it down, cut it into parts and join them afterwards, or set your real build volume in Setup.',
      status: 'fail',
    })
  }

  // --- Separate bodies --------------------------------------------------
  const shells = analysis.shells.length
  const floatTolerance = Math.max(sz * 0.01, nozzle)
  const floating = analysis.shells.filter((s) => s.bounds.min[2] > baseZ + floatTolerance).length
  if (shells <= 1) {
    checks.push({
      id: 'bodies',
      title: 'Separate bodies',
      metric: '1',
      finding: 'One connected solid.',
      advice: 'Prints as a single object.',
      status: 'pass',
    })
  } else {
    checks.push({
      id: 'bodies',
      title: 'Separate bodies',
      metric: String(shells),
      finding:
        floating === 0
          ? `${shells} separate solids, all of them reaching the plate.`
          : `${shells} separate solids, and ${floating} of them start above the plate.`,
      advice:
        floating === 0
          ? 'Fine if that is deliberate — your slicer will treat each as its own object.'
          : 'The ones that start in mid-air have nothing to print onto. Rest them on the plate or turn supports on.',
      status: floating === 0 ? 'warn' : 'fail',
    })
  }

  const failed = checks.filter((c) => c.status === 'fail').length
  const warned = checks.filter((c) => c.status === 'warn').length
  const verdict =
    failed > 0
      ? `${failed} thing${failed === 1 ? '' : 's'} to sort out before this prints`
      : warned > 0
        ? `Printable, with ${warned} thing${warned === 1 ? '' : 's'} to watch`
        : 'Ready to print as it stands'

  return { checks, verdict }
}
