import * as THREE from 'three'

/** Draw one line of text onto its own canvas, sized tight to the glyphs plus
 *  a small pad, ready to become a texture. */
export function textCanvas(text: string, color: string): HTMLCanvasElement | null {
  const fontPx = 40
  const pad = 8
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return null

  const font = `500 ${fontPx}px "JetBrains Mono", ui-monospace, monospace`
  context.font = font
  canvas.width = Math.ceil(context.measureText(text).width) + pad * 2
  canvas.height = fontPx + pad * 2
  // Resizing a canvas resets its context, so the font has to be set again.
  context.font = font
  context.fillStyle = color
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(text, canvas.width / 2, canvas.height / 2)
  return canvas
}

export function textTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  return texture
}

