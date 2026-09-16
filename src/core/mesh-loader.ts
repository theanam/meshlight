import { MeshParseError } from './formats/errors'
import { parse3mf } from './formats/threemf'
import { parseObj } from './formats/obj'
import { parsePly } from './formats/ply'
import { parseStl } from './formats/stl'
import type { RawMesh } from './types'

/** What the file picker offers and the drop screen advertises. */
export const SUPPORTED_EXTENSIONS = ['.stl', '.obj', '.ply', '.3mf'] as const

export const FILE_INPUT_ACCEPT = SUPPORTED_EXTENSIONS.join(',')

/** Strip a known mesh extension, for naming the repaired export. */
export function baseName(fileName: string): string {
  return fileName.replace(/\.(stl|obj|ply|3mf)$/i, '')
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot === -1 ? '' : fileName.slice(dot).toLowerCase()
}

/** Sniff the format from the leading bytes, for when the extension lies or is
 *  missing. Cheap checks only — the real parsers do their own validation. */
function sniff(buffer: ArrayBuffer): string | null {
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4))
  // "ply"
  if (head[0] === 0x70 && head[1] === 0x6c && head[2] === 0x79) return '.ply'
  // Every ZIP starts "PK" 03 04; for our purposes that means 3MF.
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return '.3mf'
  return null
}

/**
 * Read any supported mesh file into the triangle soup the rest of the
 * pipeline expects.
 *
 * Every format collapses to the same `RawMesh` here, so indexing, analysis,
 * scoring, sectioning and repair never learn what the file was — adding a
 * format means adding a parser and nothing else.
 */
export async function parseMesh(buffer: ArrayBuffer, fileName = ''): Promise<RawMesh> {
  if (buffer.byteLength === 0) throw new MeshParseError('That file is empty.')

  // Magic bytes beat the extension: a mislabelled file is common, and PLY and
  // 3MF both announce themselves unambiguously.
  const extension = sniff(buffer) ?? extensionOf(fileName)

  switch (extension) {
    case '.obj':
      return parseObj(buffer)
    case '.ply':
      return parsePly(buffer)
    case '.3mf':
      return parse3mf(buffer)
    case '.stl':
      return parseStl(buffer)
    default:
      // No usable extension: STL is the overwhelming default for printing,
      // and its own parser reports clearly when the bytes are not STL.
      return parseStl(buffer)
  }
}
