import { MeshParseError } from './errors'

/** Minimal ZIP reader, enough to pull one entry out of a 3MF container.
 *
 *  Deflate is handled by the platform's own DecompressionStream rather than a
 *  bundled inflate implementation — it keeps the dependency count at zero and
 *  the bundle small, which matters when everything has to ship offline. */
export async function readZipEntry(
  buffer: ArrayBuffer,
  match: (name: string) => boolean,
): Promise<{ name: string; data: Uint8Array } | null> {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  // The end-of-central-directory record sits at the tail, after a comment of
  // unknown length, so scan backwards for its signature.
  let eocd = -1
  const earliest = Math.max(0, buffer.byteLength - 66_000)
  for (let i = buffer.byteLength - 22; i >= earliest; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd === -1) throw new MeshParseError('This file is not a valid archive.')

  const entryCount = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.byteLength) break
    if (view.getUint32(offset, true) !== 0x02014b50) break

    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))

    if (match(name)) {
      // The central directory's field lengths are not always the local
      // header's, so re-read them from the local header before slicing.
      if (view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new MeshParseError('This archive is damaged.')
      }
      const localNameLength = view.getUint16(localOffset + 26, true)
      const localExtraLength = view.getUint16(localOffset + 28, true)
      const start = localOffset + 30 + localNameLength + localExtraLength
      const raw = bytes.subarray(start, start + compressedSize)

      if (method === 0) return { name, data: raw }
      if (method !== 8) throw new MeshParseError(`Unsupported compression in archive (method ${method}).`)
      return { name, data: await inflateRaw(raw) }
    }

    offset += 46 + nameLength + extraLength + commentLength
  }

  return null
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new MeshParseError('This browser cannot decompress archives, so 3MF cannot be read here.')
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
