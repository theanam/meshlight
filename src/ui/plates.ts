/** Build plate presets.
 *
 *  Printers people actually own, so picking a bed is recognising your machine
 *  rather than typing three numbers off a spec sheet. Volumes are the
 *  manufacturer's stated build area in millimetres. */
export interface PlatePreset {
  id: string
  name: string
  volume: [number, number, number]
}

export const PLATE_PRESETS: PlatePreset[] = [
  { id: 'ender3', name: 'Ender 3 / V2', volume: [220, 220, 250] },
  { id: 'prusa-mk4', name: 'Prusa MK4', volume: [250, 210, 220] },
  { id: 'prusa-mini', name: 'Prusa MINI', volume: [180, 180, 180] },
  { id: 'bambu-x1', name: 'Bambu X1 / P1S', volume: [256, 256, 256] },
  { id: 'bambu-a1-mini', name: 'Bambu A1 mini', volume: [180, 180, 180] },
  { id: 'voron-350', name: 'Voron 2.4 (350)', volume: [350, 350, 350] },
]

export function findPlate(id: string): PlatePreset | undefined {
  return PLATE_PRESETS.find((preset) => preset.id === id)
}

/** What to write on the plate in the viewport. A custom size has no name
 *  worth printing — the numbers beside it already say everything. */
export function plateLabel(id: string): string | null {
  return findPlate(id)?.name ?? null
}
