import * as THREE from 'three'
import { textCanvas, textTexture } from './label'

/** Which way the main camera should look, in world space, for each face. */
export type ViewDirection = [number, number, number]

/** Face colours. The cube is chrome, so it stays in the graphite family and
 *  well away from the defect palette — nothing here is a finding. */
/** The face colour is baked into the texture at its brightest, and the
 *  material tints it down for the resting state. A texture multiplies, so it
 *  can only darken — brightening on hover has to start from the bright end. */
const FACE = 0x3c4a60
const FACE_TINT = 0x9aa4b4
const FACE_TINT_HOVER = 0xffffff
const EDGE = 0x6d7f99
const FACE_TEXT = '#dbe3ee'

/** Axis colours, the convention every CAD tool shares: x red, y green, z blue.
 *  Taken from the brand palette's warm/cool ends rather than pure primaries so
 *  they sit in the same world as the rest of the interface. */
const AXES: { dir: ViewDirection; color: number; label: string; text: string }[] = [
  { dir: [1, 0, 0], color: 0xff6b6b, label: 'x', text: '#ff8f8f' },
  { dir: [0, 1, 0], color: 0x5fd88f, label: 'y', text: '#84e6ac' },
  { dir: [0, 0, 1], color: 0x6ea8ff, label: 'z', text: '#92bfff' },
]

/** STL is Z-up, so the faces are named for how a printed part sits: +Z is the
 *  top of the print, -Y is the side you face when you stand at the machine. */
/** `spin` turns the name on its own square so it reads upright once the face
 *  is in place. The box's UV axes are laid out for a Y-up world and this one
 *  is Z-up, so four of the six need turning. */
const FACES: { normal: ViewDirection; name: string; spin: number }[] = [
  { normal: [1, 0, 0], name: 'RIGHT', spin: -Math.PI / 2 },
  { normal: [-1, 0, 0], name: 'LEFT', spin: Math.PI / 2 },
  { normal: [0, 1, 0], name: 'BACK', spin: Math.PI },
  { normal: [0, -1, 0], name: 'FRONT', spin: 0 },
  { normal: [0, 0, 1], name: 'TOP', spin: 0 },
  { normal: [0, 0, -1], name: 'BOTTOM', spin: Math.PI },
]

const HALF = 1

/** A view cube: which way you are looking, and a click to look somewhere else.
 *
 *  Its own canvas and renderer rather than a scissored corner of the main one.
 *  The widget wants a camera that never moves and a scene of twenty triangles;
 *  sharing the viewport's renderer would mean saving and restoring viewport,
 *  scissor and clear state around every frame to gain nothing.
 *
 *  The axis triad lives inside the cube's own group, so the two cannot drift
 *  apart — they are one object that happens to be drawn in two ways. */
export class NavCube {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.OrthographicCamera
  private readonly group = new THREE.Group()
  private readonly cube: THREE.Mesh
  private readonly raycaster = new THREE.Raycaster()
  private hovered = -1

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onPick: (direction: ViewDirection) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(canvas.clientWidth || 104, canvas.clientHeight || 104, false)

    // Orthographic and fixed: the cube must not get bigger when it turns a
    // corner towards you, or it reads as moving rather than rotating.
    const reach = 2.0
    this.camera = new THREE.OrthographicCamera(-reach, reach, reach, -reach, 0.1, 100)
    this.camera.position.set(0, 0, 10)

    this.cube = new THREE.Mesh(
      new THREE.BoxGeometry(HALF * 2, HALF * 2, HALF * 2),
      FACES.map(
        (face) =>
          new THREE.MeshBasicMaterial({
            color: FACE_TINT,
            map: textTexture(faceLabel(face.name, face.spin)),
          }),
      ),
    )
    this.group.add(this.cube)
    this.group.add(
      new THREE.LineSegments(
        new THREE.EdgesGeometry(this.cube.geometry),
        new THREE.LineBasicMaterial({ color: EDGE, transparent: true, opacity: 0.85 }),
      ),
    )
    this.addAxes()
    this.scene.add(this.group)

    canvas.addEventListener('pointermove', this.onMove)
    canvas.addEventListener('pointerleave', this.onLeave)
    canvas.addEventListener('click', this.onClick)
  }

  /** The triad runs out of the cube's near-bottom-left corner, along the three
   *  edges meeting there and a little past them. Sharing the corner is what
   *  makes it read as the cube's own axes rather than a second widget. */
  private addAxes(): void {
    const corner = new THREE.Vector3(-HALF, -HALF, -HALF)
    const reach = HALF * 2.5

    for (const axis of AXES) {
      const tip = corner.clone().add(new THREE.Vector3(...axis.dir).multiplyScalar(reach))
      const geometry = new THREE.BufferGeometry().setFromPoints([corner, tip])
      this.group.add(
        new THREE.Line(
          geometry,
          // Depth-tested on purpose: an arm runs along a cube edge, and drawing
          // it over the faces instead turns the widget into a scribble.
          new THREE.LineBasicMaterial({ color: axis.color, transparent: true }),
        ),
      )

      const canvas = textCanvas(axis.label, axis.text)
      if (!canvas) continue
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: textTexture(canvas), transparent: true, depthTest: false }),
      )
      const size = 0.55
      sprite.scale.set(size * (canvas.width / canvas.height), size, 1)
      sprite.position.copy(tip).addScaledVector(new THREE.Vector3(...axis.dir), 0.22)
      this.group.add(sprite)
    }
  }

  /** Point the cube the way the camera is pointing. The cube is not steered
   *  by the camera so much as it is the camera, seen from outside. */
  sync(cameraQuaternion: THREE.Quaternion): void {
    this.group.quaternion.copy(cameraQuaternion).invert()
    this.renderer.render(this.scene, this.camera)
  }

  private readonly pick = (event: PointerEvent | MouseEvent): number => {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0) return -1
    this.raycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    )
    const hit = this.raycaster.intersectObject(this.cube, false)[0]
    return hit?.face ? Math.floor(hit.faceIndex! / 2) : -1
  }

  private readonly onMove = (event: PointerEvent): void => {
    const face = this.pick(event)
    if (face === this.hovered) return
    this.hovered = face
    this.canvas.style.cursor = face === -1 ? '' : 'pointer'
    const materials = this.cube.material as THREE.MeshBasicMaterial[]
    materials.forEach((material, i) =>
      material.color.setHex(i === face ? FACE_TINT_HOVER : FACE_TINT),
    )
  }

  private readonly onLeave = (): void => {
    this.onMove({ clientX: -1e6, clientY: -1e6 } as PointerEvent)
  }

  private readonly onClick = (event: MouseEvent): void => {
    const face = this.pick(event)
    if (face !== -1) this.onPick(FACES[face]!.normal)
  }

  dispose(): void {
    this.canvas.removeEventListener('pointermove', this.onMove)
    this.canvas.removeEventListener('pointerleave', this.onLeave)
    this.canvas.removeEventListener('click', this.onClick)
    this.scene.traverse((child) => {
      const any = child as Partial<THREE.Mesh>
      any.geometry?.dispose()
      const material = any.material
      for (const one of Array.isArray(material) ? material : material ? [material] : []) {
        ;(one as THREE.MeshBasicMaterial).map?.dispose()
        one.dispose()
      }
    })
    this.renderer.dispose()
  }
}

/** A face's name, drawn on a square so the box material tiles it cleanly, and
 *  turned so it reads the right way up once the face is in place. */
function faceLabel(name: string, spin: number): HTMLCanvasElement {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) return canvas

  context.fillStyle = '#' + FACE.toString(16).padStart(6, '0')
  context.fillRect(0, 0, size, size)

  context.translate(size / 2, size / 2)
  context.rotate(spin)
  context.fillStyle = FACE_TEXT
  context.font = '600 44px "Space Grotesk", system-ui, sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(name, 0, 0)
  return canvas
}
