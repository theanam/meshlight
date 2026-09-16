import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { orientedFootprint } from '../core/footprint'
import type { Footprint } from '../core/footprint'
import { textCanvas, textTexture } from './label'
import type { Bounds } from '../core/types'
import type { Highlights } from '../worker/protocol'

/** Defect colors come straight from the brand kit. Mint is absent on purpose:
 *  the kit reserves it for interface chrome so that any color on the mesh
 *  itself reads as "problem here". */
const DEFECT = {
  nonManifold: 0xff5c5c,
  flipped: 0xff9f45,
  degenerate: 0xf5d547,
} as const

const SURFACE = 0x8fa3bd
const EDGE = 0x1b2533
/** Mirrors --shell-select / --shell-dim in tokens.css. */
const SHELL_SELECT = 0x8c9eff
const SHELL_DIM = 0x3a4655
/** Mint, for geometry the repair added (artboard 2b). */
const PATCH = 0x6fe3b0
const SECTION_LINE = 0x6fe3b0

/** Ground grid. Graphite on purpose: a ruler under the part must never read
 *  as a finding, so it stays out of the defect colours and out of mint. */
const GRID_MINOR = 0x1d2634
const GRID_MAJOR = 0x36435a
/** The build plate. Cooler and a touch brighter than the grid it sits under,
 *  so the bed reads as a surface and the ruler reads as drawn on top of it. */
const PLATE_SURFACE = 0x223044
const PLATE_EDGE = 0x7d93ad
const PLATE_LABEL = '#8ba0b8'
const PLATE_LABEL_DIM = '#61748c'
const GRID_LABEL = '#5f6d82'

/** The bounding box is a measuring aid, not part of the model. Every other
 *  colour in this scene is cool — graphite ground, slate surface, blue-grey
 *  grid — so a warm, heavily desaturated bronze is the one hue that separates
 *  from all of it without being loud. It is nowhere near the saturated
 *  red/orange/yellow the brand kit reserves for defects, and a perfect cuboid
 *  wrapping the whole part could not be mistaken for one anyway. */
const BOX_LINE = 0x9c8f7a
const BOX_LABEL = '#c4b59b'
/** The picked part's own box. Indigo so it reads as the same selection as
 *  the shell painted underneath it, never as a second measurement. */
const PART_BOX_LINE = 0x8c9eff
const PART_BOX_LABEL = '#aab4ff'

/** Dihedral angle, in degrees, above which an edge counts as a real corner
 *  rather than tessellation of a curve. */
const FEATURE_EDGE_ANGLE = 22
const FEATURE_EDGE_LIMIT = 400_000

export type HighlightKey = keyof Highlights

export class Viewport {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly modelGroup = new THREE.Group()
  private readonly highlightGroup = new THREE.Group()
  /** The repaired mesh, held alongside the original so Before/After is a
   *  visibility flip rather than a rebuild. */
  private readonly repairGroup = new THREE.Group()
  private readonly groundGroup = new THREE.Group()
  private readonly boxGroup = new THREE.Group()
  private readonly plateGroup = new THREE.Group()
  private readonly partGroup = new THREE.Group()

  private solid: THREE.Mesh | null = null
  private shellHighlight: THREE.Mesh | null = null
  /** Kept so a shell's geometry can be rebuilt on demand. */
  private meshData: { positions: Float32Array; indices: Uint32Array; shellIds: Uint32Array } | null =
    null
  private wireframe: THREE.LineSegments | null = null
  private featureEdges: THREE.LineSegments | null = null
  private sectionLines: THREE.LineSegments | null = null
  private cutPlane: THREE.Mesh | null = null
  private readonly highlightObjects = new Map<HighlightKey, THREE.Object3D>()

  private readonly raycaster = new THREE.Raycaster()
  private bounds: Bounds | null = null
  private buildVolume: [number, number, number] = [220, 220, 250]
  private plateName: string | null = null
  private step = 0
  private frame = 0

  /** Spacing of one grid cell, in mm, so the interface can say what a square
   *  is worth. Zero until a model is loaded. */
  get gridStep(): number {
    return this.step
  }

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10_000)
    this.camera.position.set(120, -160, 110)
    this.camera.up.set(0, 0, 1) // STL is Z-up; keep the printer's sense of "up"

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08

    this.repairGroup.visible = false
    this.plateGroup.visible = false
    this.scene.add(
      this.modelGroup,
      this.highlightGroup,
      this.groundGroup,
      this.repairGroup,
      this.boxGroup,
      this.plateGroup,
      this.partGroup,
    )
    this.addLighting()

    window.addEventListener('resize', this.resize)
    this.resize()
    this.renderer.setAnimationLoop(this.tick)
  }

  /** Three-point rig (spec §5.2), warm key and cool fill so surface curvature
   *  reads without washing out the defect colors painted on top. */
  private addLighting(): void {
    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(1, -1.4, 1.6)
    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.8)
    fill.position.set(-1.4, 0.6, 0.3)
    const rim = new THREE.DirectionalLight(0xffffff, 0.6)
    rim.position.set(0.2, 1.4, -0.8)
    this.scene.add(key, fill, rim, new THREE.AmbientLight(0xffffff, 0.35))
  }

  private readonly resize = (): void => {
    const { clientWidth, clientHeight } = this.canvas
    if (clientWidth === 0 || clientHeight === 0) return
    this.renderer.setSize(clientWidth, clientHeight, false)
    this.camera.aspect = clientWidth / clientHeight
    this.camera.updateProjectionMatrix()
  }

  /** Called after each frame with the camera's orientation. The view cube
   *  follows the camera through this rather than running a second animation
   *  loop of its own, so the two can never be a frame out of step. */
  onFrame: ((orientation: THREE.Quaternion) => void) | null = null

  private readonly tick = (): void => {
    this.frame++
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
    this.onFrame?.(this.camera.quaternion)
  }

  /** Look at the model from a named direction, keeping the current distance
   *  so clicking a face of the cube changes the angle and nothing else. */
  orientTo(direction: [number, number, number]): void {
    const target = this.controls.target.clone()
    const distance = Math.max(this.camera.position.distanceTo(target), 0.001)
    const from = new THREE.Vector3(...direction).normalize()
    // Straight down or straight up has no "up" along Z to speak of, so the
    // world Y stands in — otherwise the view degenerates and the model spins.
    this.camera.up.set(0, 0, 1)
    if (Math.abs(from.z) > 0.999) this.camera.up.set(0, 1, 0)
    this.camera.position.copy(target).addScaledVector(from, distance)
    this.controls.update()
  }

  /** Back to the three-quarter view the model first opened on. */
  resetView(): void {
    this.camera.up.set(0, 0, 1)
    this.fitCamera()
  }

  setModel(
    positions: Float32Array,
    indices: Uint32Array,
    bounds: Bounds,
    shellIds: Uint32Array,
  ): void {
    this.clearModel()
    this.bounds = bounds
    this.meshData = { positions, indices, shellIds }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))

    const material = new THREE.MeshStandardMaterial({
      color: SURFACE,
      roughness: 0.55,
      metalness: 0.04,
      side: THREE.DoubleSide, // show interior walls through open boundaries
      // Flat shading is the whole point for a CAD part. Welding the mesh
      // merges the corners of adjacent faces, so averaged vertex normals
      // would round every hard edge off and invent curvature that is not in
      // the model — a chamfer that looks like a fillet, an edge that reads as
      // a crease. Flat shading derives one normal per face in the shader, so
      // what you see is the geometry the slicer will actually get.
      flatShading: true,
    })

    this.solid = new THREE.Mesh(geometry, material)
    this.modelGroup.add(this.solid)
    this.addFeatureEdges(geometry)

    this.wireframe = new THREE.LineSegments(
      new THREE.WireframeGeometry(geometry),
      new THREE.LineBasicMaterial({ color: SURFACE, transparent: true, opacity: 0.35 }),
    )
    this.wireframe.visible = false
    this.modelGroup.add(this.wireframe)

    this.buildGround()
    this.buildBox()
    this.buildPlate()
    this.fitCamera()
  }

  setBoxVisible(visible: boolean): void {
    this.boxGroup.visible = visible
  }

  /** A wireframe box on the model's extents, with its three dimensions
   *  written on it.
   *
   *  The grid tells you where things are; this tells you how big the part is
   *  without reading a number off a panel and mapping it back onto what you
   *  are looking at. It is drawn faint on purpose — it is an overlay on the
   *  model, and anything assertive there competes with the defect colours,
   *  which are the only thing in this viewport allowed to shout. */
  private buildBox(): void {
    this.clearBox()
    if (!this.bounds) return
    this.frameBox(this.boxGroup, this.bounds, this.footprintFor(null), BOX_LINE, BOX_LABEL)
  }

  /** Vertex indices to measure a footprint over: every vertex, or just the
   *  ones a shell uses. */
  private footprintFor(shellIndex: number | null): Footprint | null {
    if (!this.meshData) return null
    const { positions, indices, shellIds } = this.meshData
    const vertexCount = positions.length / 3

    // null means every vertex, which footprint.ts caches per buffer.
    if (shellIndex === null) return orientedFootprint(positions, null)

    const used = new Uint8Array(vertexCount)
    let count = 0
    for (let t = 0; t < shellIds.length; t++) {
      if (shellIds[t] !== shellIndex) continue
      for (let corner = 0; corner < 3; corner++) {
        const v = indices[t * 3 + corner]!
        if (used[v] === 0) {
          used[v] = 1
          count++
        }
      }
    }
    const list = new Uint32Array(count)
    let n = 0
    for (let v = 0; v < vertexCount; v++) if (used[v] === 1) list[n++] = v
    return orientedFootprint(positions, list)
  }

  /** Put the box in its own frame so it can be turned to sit on the part.
   *
   *  Only worth turning when it actually buys something: a part already square
   *  to the axes would otherwise pick up a fraction of a degree of skew from
   *  floating point, and a box that is almost straight reads as a mistake. */
  private frameBox(
    parent: THREE.Group,
    bounds: Bounds,
    footprint: Footprint | null,
    line: number,
    label: string,
  ): void {
    const axisAlignedArea = bounds.size[0] * bounds.size[1]
    const turned =
      footprint !== null &&
      axisAlignedArea > 0 &&
      footprint.width * footprint.depth < axisAlignedArea * 0.98

    if (!turned) {
      this.drawBox(parent, bounds, line, label, null)
      return
    }

    const holder = new THREE.Group()
    holder.position.set(footprint!.center[0], footprint!.center[1], 0)
    holder.rotation.z = footprint!.angle
    parent.add(holder)

    // Local frame: the holder carries the turn and the XY offset, so Z stays
    // world Z and the labels below need no special case for it.
    const z0 = bounds.min[2]
    const z1 = bounds.max[2]
    const halfW = footprint!.width / 2
    const halfD = footprint!.depth / 2
    this.drawBox(
      holder,
      {
        min: [-halfW, -halfD, z0],
        max: [halfW, halfD, z1],
        size: [footprint!.width, footprint!.depth, z1 - z0],
        center: [0, 0, (z0 + z1) / 2],
      },
      line,
      label,
      footprint!.angle,
    )
  }

  /** The box for one picked part, drawn in the selection colour so it reads as
   *  belonging to the shell highlighted underneath it. */
  /** Drop the model's own box back while a part is selected. Two sets of
   *  dimensions at full strength read as one overlapping jumble, and the
   *  question being asked at that moment is about the part. */
  private dimModelBox(dimmed: boolean): void {
    this.boxGroup.traverse((child) => {
      const material = (child as Partial<THREE.Mesh>).material
      for (const one of Array.isArray(material) ? material : material ? [material] : []) {
        const base = (one.userData.baseOpacity as number | undefined) ?? one.opacity
        one.userData.baseOpacity = base
        one.opacity = dimmed ? base * 0.22 : base
        one.transparent = true
      }
    })
  }

  private buildPartBox(shellIndex: number | null): void {
    for (const child of [...this.partGroup.children]) {
      this.partGroup.remove(child)
      disposeObject(child)
    }
    if (shellIndex === null) return
    const bounds = this.shellBounds(shellIndex)
    if (!bounds) return
    this.frameBox(
      this.partGroup,
      bounds,
      this.footprintFor(shellIndex),
      PART_BOX_LINE,
      PART_BOX_LABEL,
    )
  }

  private drawBox(
    group: THREE.Group,
    bounds: Bounds,
    line: number,
    label: string,
    /** Radians the box has been turned about Z, or null if it is axis-aligned.
     *  A turned box is no longer measuring X and Y, so its labels say so. */
    turn: number | null,
  ): void {
    const [x0, y0, z0] = bounds.min
    const [x1, y1, z1] = bounds.max
    const corners: [number, number, number][] = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ]
    // Four along the base, four up the sides, four around the top.
    const edges: [number, number][] = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [0, 4], [1, 5], [2, 6], [3, 7],
      [4, 5], [5, 6], [6, 7], [7, 4],
    ]
    const points: number[] = []
    for (const [a, b] of edges) points.push(...corners[a]!, ...corners[b]!)

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3))
    group.add(
      new THREE.LineSegments(
        geometry,
        // No depth test: a box that disappears inside the part it measures is
        // worse than one drawn over it.
        new THREE.LineBasicMaterial({
          color: line,
          transparent: true,
          opacity: 0.5,
          depthTest: false,
        }),
      ),
    )

    const [sx, sy, sz] = bounds.size
    const [cx, cy, cz] = bounds.center
    // Sized off the model, not off this box and not off the grid.
    //
    // Off the grid was the original bug: the major step moves in 1-2-5 jumps,
    // so a 552 mm model lands on a 100 mm major and gets 42 mm text, while an
    // 80 mm one lands on 10 and gets 4 — the same design at two scales, four
    // times heavier at one of them.
    //
    // Off this box is wrong for a different reason: the camera frames the
    // model, so a part's own size says nothing about how big its label lands
    // on screen. A small part would get text too small to read at the
    // distance you are actually viewing from.
    //
    // The model is what the camera is fitted to, so a fraction of it is a
    // fraction of the screen. Both boxes end up at one size, which is also the
    // right answer — colour already says which is which.
    const modelSpan = this.bounds ? Math.max(...this.bounds.size) : Math.max(sx, sy, sz)
    const height = modelSpan * 0.05
    const gap = height * 0.7
    // One dimension per axis, written along the edge it measures and just
    // clear of it: width on the front bottom edge, depth on the right-hand
    // one, height up the near vertical. Each is named, because three bare
    // numbers in space do not say which is which.
    const V = THREE.Vector3
    this.addEdgeLabel(
      group,
      turn === null
        ? `X ${fmtDim(sx)}`
        : `X\u2032 ${fmtDim(sx)} @ ${((turn * 180) / Math.PI).toFixed(1)}\u00b0`,
      new V(cx, y0 - gap, z0),
      new V(1, 0, 0),
      new V(0, 1, 0),
      height,
      { color: label },
    )
    this.addEdgeLabel(
      group,
      turn === null ? `Y ${fmtDim(sy)}` : `Y\u2032 ${fmtDim(sy)}`,
      new V(x1 + gap, cy, z0),
      new V(0, 1, 0),
      new V(-1, 0, 0),
      height,
      { color: label },
    )
    this.addEdgeLabel(
      group,
      `Z ${fmtDim(sz)}`,
      new V(x0 - gap, y0, cz),
      new V(0, 0, 1),
      new V(-1, 0, 0),
      height,
      { color: label },
    )
  }

  /** A line of text lying in world space along a box edge.
   *
   *  A billboard that swings to face the camera reads as a tag floating near
   *  the part; a dimension belongs on the line it measures, the way it is
   *  drawn on any engineering drawing. So this is a textured quad with a
   *  fixed orientation: `along` runs left-to-right through the glyphs, `up`
   *  is the direction they stand in, and the quad's facing falls out of the
   *  two. Both are unit axes here, so the cross product needs no normalising.
   *
   *  The trade is that text on a face turned away from you reads mirrored,
   *  which is the same trade a drawing makes. */
  private addEdgeLabel(
    group: THREE.Group,
    text: string,
    centre: THREE.Vector3,
    along: THREE.Vector3,
    up: THREE.Vector3,
    height: number,
    options: {
      color?: string
      /** Where `centre` sits along the text: 0 its start, 0.5 its middle, 1 its end. */
      anchor?: number
      /** Box annotations draw through the part; things lying on the plate
       *  should be hidden by it like any other surface. */
      depthTest?: boolean
      renderOrder?: number
    } = {},
  ): void {
    const canvas = textCanvas(text, options.color ?? BOX_LABEL)
    if (!canvas) return

    const width = height * (canvas.width / canvas.height)
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({
        map: textTexture(canvas),
        transparent: true,
        depthWrite: false,
        depthTest: options.depthTest ?? false,
        side: THREE.DoubleSide,
      }),
    )
    const facing = new THREE.Vector3().crossVectors(along, up)
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(along, up, facing))
    // The quad is built around its own middle, so any other anchor is a slide
    // along the reading direction.
    mesh.position.copy(centre).addScaledVector(along, (0.5 - (options.anchor ?? 0.5)) * width)
    mesh.renderOrder = options.renderOrder ?? 2
    group.add(mesh)
  }

  private clearBox(): void {
    for (const child of [...this.boxGroup.children]) {
      this.boxGroup.remove(child)
      disposeObject(child)
    }
  }

  /** The plate is drawn from the configured build volume, so picking a
   *  different printer — or editing the numbers in Setup — has to redraw it. */
  setBuildVolume(volume: [number, number, number], name: string | null = null): void {
    this.buildVolume = volume
    this.plateName = name
    if (this.bounds) this.buildPlate()
  }

  setPlateVisible(visible: boolean): void {
    this.plateGroup.visible = visible
  }

  /** Draw the build plate as a plate rather than as a rectangle.
   *
   *  A bare outline says "something is this big" and nothing else; the point
   *  of putting a bed under the part is to see the part standing on it. So
   *  this is a surface with a rounded edge, the inset line where a spring
   *  steel sheet stops short of the bed, and the machine's name written on
   *  it — the details that make the eye read "printer bed".
   *
   *  It answers "will this fit", which is a question about size and not about
   *  placement — the score asks it the same way, trying the part both ways
   *  round. So it is centred on the part's own footprint rather than guessing
   *  where the origin of someone's bed is. */
  private buildPlate(): void {
    this.clearPlate()
    if (!this.bounds) return

    const [bx, by] = this.buildVolume
    const [mx, my] = this.bounds.center
    const z = this.bounds.min[2]
    // The bed sits a hair under the grid, so the ruler stays legible across it
    // instead of z-fighting with it.
    const under = Math.max(bx, by) * 3e-4

    const radius = Math.min(bx, by) * 0.045
    const outer = roundedRect(bx, by, radius)

    const surface = new THREE.Mesh(
      new THREE.ShapeGeometry(outer),
      new THREE.MeshBasicMaterial({
        color: PLATE_SURFACE,
        transparent: true,
        // Low enough that the grid still reads through the bed: the plate is
        // context for the part, not a lid over the ruler.
        opacity: 0.38,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    surface.position.set(mx, my, z - under)
    surface.renderOrder = -3
    this.plateGroup.add(surface)

    const rim = z - under * 0.5
    this.addPlateLoop(outer.getPoints(96), mx, my, rim, 0.85)

    const inset = Math.min(bx, by) * 0.035
    this.addPlateLoop(
      roundedRect(bx - inset * 2, by - inset * 2, Math.max(radius - inset, radius * 0.4)).getPoints(96),
      mx,
      my,
      rim,
      0.3,
    )

    // Write the machine on the bed, the way a slicer does. The name belongs
    // to the surface, not to a tag floating beside it — and along the inside
    // of an edge it stays clear of whatever is sitting on the plate.
    //
    // Sized off the bed, not off the grid: the grid is scaled to the part, so
    // a 40 mm bracket would otherwise set 2 mm text on a 220 mm plate.
    const height = Math.max(bx, by) * 0.038
    const margin = inset * 1.9
    // Centred on each edge rather than tucked into a corner: the corners are
    // where the fixings are, and lying flat costs a label enough size to
    // foreshortening without it fighting a screw as well.
    this.addEdgeLabel(
      this.plateGroup,
      this.plateName ?? 'Custom plate',
      new THREE.Vector3(mx, my - by / 2 + margin, rim),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      height,
      { color: PLATE_LABEL, depthTest: true, renderOrder: -1 },
    )
    // The volume runs up the right-hand edge, so the two never meet and each
    // reads along the side it belongs to.
    this.addEdgeLabel(
      this.plateGroup,
      `${fmtMm(bx)} \u00d7 ${fmtMm(by)} \u00d7 ${fmtMm(this.buildVolume[2])} mm`,
      new THREE.Vector3(mx + bx / 2 - margin, my, rim),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(-1, 0, 0),
      height * 0.68,
      { color: PLATE_LABEL_DIM, depthTest: true, renderOrder: -1 },
    )
  }

  private addPlateLoop(
    points: THREE.Vector2[],
    ox: number,
    oy: number,
    z: number,
    opacity: number,
  ): void {
    const flat = new Float32Array(points.length * 3)
    points.forEach((p, i) => {
      flat[i * 3] = ox + p.x
      flat[i * 3 + 1] = oy + p.y
      flat[i * 3 + 2] = z
    })
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(flat, 3))
    const loop = new THREE.LineLoop(
      geometry,
      new THREE.LineBasicMaterial({ color: PLATE_EDGE, transparent: true, opacity }),
    )
    loop.renderOrder = -2
    this.plateGroup.add(loop)
  }

  private clearPlate(): void {
    for (const child of [...this.plateGroup.children]) {
      this.plateGroup.remove(child)
      disposeObject(child)
    }
  }

  setGridVisible(visible: boolean): void {
    this.groundGroup.visible = visible
  }

  /** Lay a ruler under the part: a grid on the build plane, at the height the
   *  model's lowest point sits, plus the outline of the configured plate.
   *
   *  Without it a viewport gives you shape but no size — a 4 mm bracket and a
   *  300 mm vase fill the frame identically once the camera has fitted to
   *  them. Spacing adapts so both get roughly twenty cells across, and always
   *  lands on a 1, 2 or 5 x 10^n step, so counting squares is arithmetic you
   *  can do by eye. Every fifth line (every second, when the step is a 5) is
   *  drawn stronger, which is what makes a count possible at all. */
  private buildGround(): void {
    this.clearGround()
    if (!this.bounds) return

    const [sx, sy] = this.bounds.size
    const span = Math.max(sx, sy, 1e-4)
    const minor = niceStep(span / 20)
    // Majors every 5 minors, except on a 5-step where that would land on 25 —
    // a number nobody counts in. There, every second line gives a round 10.
    const perMajor = mantissa(minor) === 5 ? 2 : 5
    const major = minor * perMajor
    this.step = minor

    // Extent follows the model, not the plate: a 2 mm part on a 220 mm bed
    // would otherwise need thousands of lines to stay at a readable spacing.
    const half = Math.ceil(Math.max(span * 0.75, major) / major) * major
    const steps = Math.min(Math.round(half / minor), 400)
    const reach = steps * minor
    // Snapping the centre to a major line keeps the strong lines on round
    // coordinates rather than on an arbitrary offset from the model's middle.
    const cx = Math.round(this.bounds.center[0] / major) * major
    const cy = Math.round(this.bounds.center[1] / major) * major
    const z = this.bounds.min[2]

    const minorPoints: number[] = []
    const majorPoints: number[] = []
    for (let i = -steps; i <= steps; i++) {
      const offset = i * minor
      const into = i % perMajor === 0 ? majorPoints : minorPoints
      into.push(cx + offset, cy - reach, z, cx + offset, cy + reach, z)
      into.push(cx - reach, cy + offset, z, cx + reach, cy + offset, z)
    }

    this.addGroundLines(minorPoints, GRID_MINOR, 0.5)
    this.addGroundLines(majorPoints, GRID_MAJOR, 0.85)

    // Numbers on the major lines. Without them the grid only says "the cells
    // are all the same size" and you are left counting boxes and guessing what
    // one is worth; with them the plane reads as a ruler, in the same
    // millimetre coordinates the report quotes for every defect.
    // Small and quiet. These are a reference the eye should be able to find
    // when it goes looking, not something it has to read past to see the
    // part — at the previous size they sat on the model like a caption.
    const textHeight = major * 0.2
    const gap = major * 0.12
    const majors = Math.floor(steps / perMajor)
    for (let m = -majors; m <= majors; m++) {
      const offset = m * major
      // X along the near edge, hanging below it; Y down the left edge, ending
      // just clear of it. Anchors keep both clear of the lines they label.
      this.addLabel(this.groundGroup, fmtMm(cx + offset), [cx + offset, cy - reach - gap, z], [0.5, 1], textHeight)
      this.addLabel(this.groundGroup, fmtMm(cy + offset), [cx - reach - gap, cy + offset, z], [1, 0.5], textHeight)
    }
    // Which number is which axis, said once rather than on every tick. These
    // stand further out than the ticks do: the last number on each edge runs
    // past the corner, and a tag butted up against it would collide.
    const tag = gap * 4
    this.addLabel(this.groundGroup, 'X mm', [cx + reach + tag, cy - reach - gap, z], [0, 1], textHeight)
    this.addLabel(this.groundGroup, 'Y mm', [cx - reach - gap, cy + reach + tag, z], [1, 0], textHeight)
  }

  /** One piece of text on the ground plane, drawn to a canvas and hung on a
   *  sprite so it always faces the camera however the model is orbited.
   *
   *  The text is sized in model space, off the grid's own major step, so it
   *  stays in proportion to the ruler it belongs to at any scale of part —
   *  a fixed pixel size would swamp a 2 mm bracket and vanish on a 700 mm one. */
  private addLabel(
    group: THREE.Group,
    text: string,
    [x, y, z]: [number, number, number],
    [anchorX, anchorY]: [number, number],
    height: number,
    color: string = GRID_LABEL,
  ): void {
    const canvas = textCanvas(text, color)
    if (!canvas) return
    const texture = textTexture(canvas)

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
    )
    sprite.center.set(anchorX, anchorY)
    sprite.position.set(x, y, z)
    sprite.scale.set(height * (canvas.width / canvas.height), height, 1)
    group.add(sprite)
  }

  private addGroundLines(points: number[], color: number, opacity: number): void {
    if (points.length === 0) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3))
    const lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
    )
    // Behind everything: the part occludes the grid, never the other way.
    lines.renderOrder = -1
    this.groundGroup.add(lines)
  }

  private clearGround(): void {
    for (const child of [...this.groundGroup.children]) {
      this.groundGroup.remove(child)
      disposeObject(child)
    }
    this.step = 0
  }

  /** Outline the edges where two faces actually meet at an angle.
   *
   *  Flat shading alone leaves a part reading as a soft blob under even
   *  lighting; CAD viewports draw feature edges on top, and without them it
   *  is genuinely hard to tell where a face ends. EdgesGeometry keeps only
   *  edges whose dihedral angle exceeds the threshold, so tessellated
   *  curves stay clean while real corners get a line. */
  private addFeatureEdges(geometry: THREE.BufferGeometry): void {
    const triangleCount = (geometry.getIndex()?.count ?? 0) / 3
    // EdgesGeometry walks every face pair; past this size the cost is not
    // worth it and the lines would be denser than the pixels anyway.
    if (triangleCount === 0 || triangleCount > FEATURE_EDGE_LIMIT) return

    this.featureEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, FEATURE_EDGE_ANGLE),
      new THREE.LineBasicMaterial({ color: EDGE, transparent: true, opacity: 0.55 }),
    )
    this.modelGroup.add(this.featureEdges)
  }

  setHighlights(highlights: Highlights): void {
    for (const object of this.highlightObjects.values()) {
      this.highlightGroup.remove(object)
      disposeObject(object)
    }
    this.highlightObjects.clear()

    this.addLineHighlight('nonManifold', highlights.nonManifold, DEFECT.nonManifold, 2)
    // Open boundaries are the other half of "not watertight", so they share
    // the non-manifold red rather than introducing a fourth defect color.
    this.addLineHighlight('boundary', highlights.boundary, DEFECT.nonManifold, 2)
    this.addFaceHighlight('flipped', highlights.flipped, DEFECT.flipped)
    this.addFaceHighlight('degenerate', highlights.degenerate, DEFECT.degenerate)
  }

  private addLineHighlight(key: HighlightKey, data: Float32Array, color: number, width: number): void {
    if (data.length === 0) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(data, 3))
    const object = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color, linewidth: width, depthTest: false, transparent: true }),
    )
    object.renderOrder = 2 // defects must stay visible through the surface
    this.highlightGroup.add(object)
    this.highlightObjects.set(key, object)
  }

  private addFaceHighlight(key: HighlightKey, data: Float32Array, color: number): void {
    if (data.length === 0) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(data, 3))
    geometry.computeVertexNormals()
    const object = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }),
    )
    object.renderOrder = 1
    this.highlightGroup.add(object)
    this.highlightObjects.set(key, object)
  }

  setHighlightVisible(key: HighlightKey, visible: boolean): void {
    const object = this.highlightObjects.get(key)
    if (object) object.visible = visible
  }

  showOnly(keys: HighlightKey[] | null): void {
    for (const [key, object] of this.highlightObjects) {
      object.visible = keys === null || keys.includes(key)
    }
  }

  setShaded(shaded: boolean): void {
    if (this.solid) this.solid.visible = shaded
    if (this.featureEdges) this.featureEdges.visible = shaded
    if (this.wireframe) this.wireframe.visible = !shaded
  }

  /** Draw the cross-section as line segments sitting on the cut plane. */
  setSection(segments: Float32Array, z: number): void {
    this.clearSection()
    if (!this.bounds) return

    if (segments.length > 0) {
      // Segments arrive as 2D (x, y) pairs; lift them onto the plane.
      const points = new Float32Array((segments.length / 2) * 3)
      for (let i = 0; i < segments.length / 2; i++) {
        points[i * 3 + 0] = segments[i * 2]!
        points[i * 3 + 1] = segments[i * 2 + 1]!
        points[i * 3 + 2] = z
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(points, 3))
      this.sectionLines = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({ color: SECTION_LINE, depthTest: false, transparent: true }),
      )
      this.sectionLines.renderOrder = 3
      this.scene.add(this.sectionLines)
    }

    const [sx, sy] = this.bounds.size
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(sx * 1.15 || 1, sy * 1.15 || 1),
      new THREE.MeshBasicMaterial({
        color: SECTION_LINE,
        transparent: true,
        opacity: 0.06,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    plane.position.set(this.bounds.center[0], this.bounds.center[1], z)
    this.scene.add(plane)
    this.cutPlane = plane
  }

  clearSection(): void {
    if (this.sectionLines) {
      this.scene.remove(this.sectionLines)
      disposeObject(this.sectionLines)
      this.sectionLines = null
    }
    if (this.cutPlane) {
      this.scene.remove(this.cutPlane)
      disposeObject(this.cutPlane)
      this.cutPlane = null
    }
  }

  /** Hide everything above the given Z so the cutaway reveals the interior. */
  setClipZ(z: number | null): void {
    const material = this.solid?.material as THREE.MeshStandardMaterial | undefined
    if (!material) return
    if (z === null) {
      this.renderer.localClippingEnabled = false
      material.clippingPlanes = null
    } else {
      this.renderer.localClippingEnabled = true
      material.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, -1), z)]
    }
    material.needsUpdate = true
  }

  fitCamera(): void {
    if (!this.bounds) return
    const [cx, cy, cz] = this.bounds.center
    const [sx, sy, sz] = this.bounds.size
    // A visible plate is part of what you asked to see. Framing the part
    // alone leaves a 220 mm bed off screen under an 80 mm bracket, which
    // makes turning the plate on look like it did nothing — and seeing a
    // small part on a big bed is the whole reason to draw one.
    const [bx, by] = this.plateGroup.visible ? this.buildVolume : [0, 0]
    const extent = Math.hypot(Math.max(sx, bx), Math.max(sy, by), sz)
    const radius = Math.max(extent / 2, 0.001)
    const distance = radius / Math.sin((this.camera.fov * Math.PI) / 360)

    this.controls.target.set(cx, cy, cz)
    this.camera.position.set(cx + distance * 0.62, cy - distance * 0.72, cz + distance * 0.5)
    this.camera.near = Math.max(radius / 1000, 0.01)
    this.camera.far = distance * 12
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  /** Show the outcome of a repair without touching the loaded mesh.
   *
   *  The patch is drawn in mint over the result: artboard 2b uses mint for
   *  patched geometry, which is the one place the brand kit lets it onto the
   *  mesh — it reads as "added", never as a defect. */
  setRepairPreview(positions: Float32Array, indices: Uint32Array, patch: Float32Array): void {
    this.clearRepair()

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))

    this.repairGroup.add(
      new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: SURFACE,
          roughness: 0.55,
          metalness: 0.04,
          side: THREE.DoubleSide,
          flatShading: true,
        }),
      ),
    )

    const triangleCount = indices.length / 3
    if (triangleCount > 0 && triangleCount <= FEATURE_EDGE_LIMIT) {
      this.repairGroup.add(
        new THREE.LineSegments(
          new THREE.EdgesGeometry(geometry, FEATURE_EDGE_ANGLE),
          new THREE.LineBasicMaterial({ color: EDGE, transparent: true, opacity: 0.55 }),
        ),
      )
    }

    if (patch.length > 0) {
      const patchGeometry = new THREE.BufferGeometry()
      patchGeometry.setAttribute('position', new THREE.BufferAttribute(patch, 3))
      patchGeometry.computeVertexNormals()
      const patchMesh = new THREE.Mesh(
        patchGeometry,
        new THREE.MeshStandardMaterial({
          color: PATCH,
          roughness: 0.4,
          side: THREE.DoubleSide,
          flatShading: true,
        }),
      )
      patchMesh.renderOrder = 1
      this.repairGroup.add(patchMesh)
    }
  }

  /** Flip between the loaded mesh and the repaired preview. */
  showRepair(show: boolean): void {
    this.repairGroup.visible = show && this.repairGroup.children.length > 0
    this.modelGroup.visible = !this.repairGroup.visible
    // Defect highlights belong to the original; hide them over the repair.
    this.highlightGroup.visible = !this.repairGroup.visible
  }

  clearRepair(): void {
    for (const child of [...this.repairGroup.children]) {
      this.repairGroup.remove(child)
      disposeObject(child)
    }
    this.repairGroup.visible = false
    this.modelGroup.visible = true
    this.highlightGroup.visible = true
  }

  /** Which part is under this point on screen, or null for empty space.
   *
   *  The cast is against the solid alone: the grid, the plate and the boxes
   *  are annotation, and having them swallow a click would make the model
   *  feel unreachable through its own chrome. `faceIndex` is the triangle
   *  index, which is exactly what shellIds is keyed by. */
  pickShell(clientX: number, clientY: number): number | null {
    if (!this.solid || !this.meshData) return null
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null

    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(ndc, this.camera)
    const hit = this.raycaster.intersectObject(this.solid, false)[0]
    // faceIndex is typed as possibly null as well as absent.
    if (!hit || hit.faceIndex == null) return null
    return this.meshData.shellIds[hit.faceIndex] ?? null
  }

  /** Extents of one shell, walked on demand.
   *
   *  Not precomputed for every shell: a part can have hundreds, only one is
   *  ever selected, and a single pass over the triangle list costs less than
   *  shipping a bounds table across the worker boundary for all of them. */
  private shellBounds(shellIndex: number): Bounds | null {
    if (!this.meshData) return null
    const { positions, indices, shellIds } = this.meshData
    const min: [number, number, number] = [Infinity, Infinity, Infinity]
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    let found = false

    for (let t = 0; t < shellIds.length; t++) {
      if (shellIds[t] !== shellIndex) continue
      found = true
      for (let corner = 0; corner < 3; corner++) {
        const v = indices[t * 3 + corner]!
        for (let axis = 0; axis < 3; axis++) {
          const value = positions[v * 3 + axis]!
          if (value < min[axis]!) min[axis] = value
          if (value > max[axis]!) max[axis] = value
        }
      }
    }
    if (!found) return null

    return {
      min,
      max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    }
  }

  /** Paint one shell in the isolation colour and drop everything else back,
   *  so a model made of several solids can be taken apart by eye.
   *
   *  Passing null restores the normal surface. The highlight is built on
   *  demand from the shell ids rather than kept around for every shell,
   *  because a part can have hundreds and only one is ever shown. */
  highlightShell(shellIndex: number | null): void {
    // The box belongs to the selection, so it is drawn and cleared here
    // rather than by a second call the two could get out of step on.
    this.buildPartBox(shellIndex)
    this.dimModelBox(shellIndex !== null)

    if (this.shellHighlight) {
      this.modelGroup.remove(this.shellHighlight)
      disposeObject(this.shellHighlight)
      this.shellHighlight = null
    }

    const material = this.solid?.material as THREE.MeshStandardMaterial | undefined
    if (!material || !this.meshData) return

    if (shellIndex === null) {
      material.color.setHex(SURFACE)
      if (this.featureEdges) (this.featureEdges.material as THREE.Material).opacity = 0.55
      return
    }

    const { positions, indices, shellIds } = this.meshData
    const members: number[] = []
    for (let t = 0; t < shellIds.length; t++) {
      if (shellIds[t] === shellIndex) members.push(t)
    }
    if (members.length === 0) return

    const data = new Float32Array(members.length * 9)
    members.forEach((t, i) => {
      for (let corner = 0; corner < 3; corner++) {
        const v = indices[t * 3 + corner]!
        data[i * 9 + corner * 3 + 0] = positions[v * 3]!
        data[i * 9 + corner * 3 + 1] = positions[v * 3 + 1]!
        data[i * 9 + corner * 3 + 2] = positions[v * 3 + 2]!
      }
    })

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(data, 3))
    this.shellHighlight = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: SHELL_SELECT,
        roughness: 0.45,
        metalness: 0.04,
        side: THREE.DoubleSide,
        flatShading: true,
      }),
    )
    this.modelGroup.add(this.shellHighlight)

    // Push the rest back so the selected shell is the only thing reading as
    // solid — recolouring alone is not enough when a shell is enclosed.
    material.color.setHex(SHELL_DIM)
    if (this.featureEdges) (this.featureEdges.material as THREE.Material).opacity = 0.25
  }

  /** Point the camera at a defect, keeping the current viewing angle so
   *  clicking through a report never disorients.
   *
   *  Passing a focusRadius frames that one defect: the distance follows the
   *  defect's own size rather than a fixed fraction of the model, which is
   *  what kept putting the camera inside the solid. The lower bound stops a
   *  hairline edge from pulling the camera to within a millimetre of it. */
  focusOn(point: [number, number, number], focusRadius?: number): void {
    const target = new THREE.Vector3(...point)
    const offset = this.camera.position.clone().sub(this.controls.target)
    const modelRadius = this.bounds ? Math.hypot(...this.bounds.size) / 2 : 1
    const distance =
      focusRadius === undefined
        ? modelRadius * 0.55
        : Math.max(focusRadius * 3, modelRadius * 0.25)
    offset.setLength(Math.max(distance, 0.001))

    this.controls.target.copy(target)
    this.camera.position.copy(target).add(offset)

    // A defect's centroid can sit deep inside the solid — the average of a
    // plate's open edges lands in the middle of the plate — which would park
    // the camera inside the mesh looking at back faces. Push it out along the
    // same direction until it clears the model's bounding sphere.
    if (this.bounds) {
      const centre = new THREE.Vector3(...this.bounds.center)
      const clearance = modelRadius * 1.15
      const fromCentre = this.camera.position.distanceTo(centre)
      if (fromCentre < clearance) {
        this.camera.position.add(offset.clone().setLength(clearance - fromCentre))
      }
    }

    this.controls.update()
  }

  private clearModel(): void {
    for (const child of [...this.modelGroup.children]) {
      this.modelGroup.remove(child)
      disposeObject(child)
    }
    this.solid = null
    this.wireframe = null
    this.featureEdges = null
    this.shellHighlight = null
    this.meshData = null
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize)
    this.renderer.setAnimationLoop(null)
    this.clearModel()
    this.clearSection()
    this.clearRepair()
    this.clearGround()
    this.clearBox()
    this.buildPartBox(null)
    this.clearPlate()
    this.renderer.dispose()
  }
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const any = child as Partial<THREE.Mesh>
    any.geometry?.dispose()
    const material = any.material
    const materials = Array.isArray(material) ? material : material ? [material] : []
    for (const one of materials) {
      // A label's canvas texture is owned by its material and is not freed by
      // disposing the material alone.
      ;(one as THREE.SpriteMaterial).map?.dispose()
      one.dispose()
    }
  })
}

/** Round a raw spacing up to the nearest 1, 2 or 5 times a power of ten —
 *  the steps a ruler is actually marked in. */
function niceStep(raw: number): number {
  const decade = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-6)))
  const scaled = raw / decade
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10
  return nice * decade
}

/** The 1, 2 or 5 in a step produced by niceStep. */
function mantissa(step: number): number {
  return Math.round(step / 10 ** Math.floor(Math.log10(step)))
}

/** Grid coordinates land on round multiples of the step by construction, so
 *  print them as such — "0.5", not "0.50"; "20", not "20.0" — and clear the
 *  float noise a repeated multiply leaves behind. */
function fmtMm(value: number): string {
  const rounded = Number(value.toPrecision(12))
  return String(rounded === 0 ? 0 : rounded)
}

/** Box dimensions are measurements, not round numbers, so they keep two
 *  decimals — the same precision the report quotes defect coordinates in. */
function fmtDim(value: number): string {
  return value.toFixed(2)
}

/** A rectangle with rounded corners, centred on the origin in the XY plane.
 *  Square corners are what makes a drawn bed read as a box rather than a
 *  piece of hardware. */
function roundedRect(width: number, height: number, radius: number): THREE.Shape {
  const shape = new THREE.Shape()
  const x = -width / 2
  const y = -height / 2
  const r = Math.min(radius, Math.min(width, height) / 2)
  shape.moveTo(x + r, y)
  shape.lineTo(x + width - r, y)
  shape.quadraticCurveTo(x + width, y, x + width, y + r)
  shape.lineTo(x + width, y + height - r)
  shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  shape.lineTo(x + r, y + height)
  shape.quadraticCurveTo(x, y + height, x, y + height - r)
  shape.lineTo(x, y + r)
  shape.quadraticCurveTo(x, y, x + r, y)
  return shape
}
