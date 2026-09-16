/** Colours the model itself can be painted in.
 *
 *  The viewport is not free to use any colour it likes. Saturated red, orange
 *  and yellow are the defect set, mint means geometry a repair added, and
 *  periwinkle means the part you picked — every one of those is a claim about
 *  the mesh, and a body wearing one would be making that claim by accident.
 *  So this palette stays where nothing else is speaking: neutrals, and hues
 *  held far enough down in saturation that they read as a material rather than
 *  as a finding. They are filament colours on purpose — a part is easier to
 *  judge in something close to what it will be printed in, and a light bone
 *  shows shallow surface detail that slate swallows. */
export interface MeshColor {
  id: string
  name: string
  hex: number
  /** What this one is good for, shown beside the name in the menu. */
  note: string
}

export const MESH_COLORS: MeshColor[] = [
  { id: 'slate', name: 'Slate', hex: 0x8fa3bd, note: 'default' },
  { id: 'bone', name: 'Bone', hex: 0xd9d2c2, note: 'natural PLA' },
  { id: 'graphite', name: 'Graphite', hex: 0x4b5462, note: 'dark' },
  { id: 'steel', name: 'Steel', hex: 0x5f7fa6, note: 'deep blue' },
  { id: 'copper', name: 'Copper', hex: 0xa9724c, note: 'warm' },
  { id: 'sage', name: 'Sage', hex: 0x7f9b7a, note: 'muted green' },
]

export const DEFAULT_MESH_COLOR = MESH_COLORS[0]!

export function findMeshColor(id: string): MeshColor | undefined {
  return MESH_COLORS.find((color) => color.id === id)
}

/** The hex a preset id names, falling back to the default for an id that is
 *  no longer in the list — a saved setting outlives the palette it was
 *  chosen from. */
export function meshColorHex(id: string): number {
  return (findMeshColor(id) ?? DEFAULT_MESH_COLOR).hex
}

/** The same colour, a given fraction as bright.
 *
 *  Done on the raw channels rather than through THREE.Color.multiplyScalar,
 *  which scales the linear values the renderer keeps internally — a 0.76 there
 *  lands near 0.88 of the colour you can see, which is not enough separation
 *  for the cut face to read as a different surface from the skin. */
export function shade(hex: number, factor: number): number {
  const channel = (shift: number): number =>
    Math.max(0, Math.min(255, Math.round(((hex >> shift) & 0xff) * factor)))
  return (channel(16) << 16) | (channel(8) << 8) | channel(0)
}

/** CSS colour for a swatch in the menu. */
export function cssHex(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`
}
