import { MeshParseError } from './errors'

/** One file inside the archive, read on demand. */
export interface ZipEntry {
  name: string
  read(): Promise<Uint8Array>
}

const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** Value stood in for by ZIP64 when a 32-bit field cannot hold the real one. */
const SENTINEL_32 = 0xffffffff
const SENTINEL_16 = 0xffff

/**
 * Minimal ZIP reader, enough to pull the parts of a 3MF container out.
 *
 * Deflate is handled by the platform's own DecompressionStream rather than a
 * bundled inflate implementation — it keeps the dependency count at zero and
 * the bundle small, which matters when everything has to ship offline.
 *
 * ZIP64 is not optional here. Plenty of real 3MF files use it even when they
 * are only tens of kilobytes, because the writer opts in rather than waiting
 * to cross 4 GB; those archives put sentinel values in the ordinary
 * end-of-central-directory record and the true ones in a ZIP64 record behind
 * it. Reading only the 32-bit fields finds no entries at all.
 */
export function readZip(buffer: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  // The end-of-central-directory record sits at the tail, after a comment of
  // unknown length, so scan backwards for its signature.
  let eocd = -1
  const earliest = Math.max(0, buffer.byteLength - 66_000)
  for (let i = buffer.byteLength - 22; i >= earliest; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break }
  }
  if (eocd === -1) throw new MeshParseError('This file is not a valid archive.')

  let entryCount = view.getUint16(eocd + 10, true)
  let directoryOffset = view.getUint32(eocd + 16, true)

  // A ZIP64 locator sits immediately before the EOCD and points at the record
  // holding the real counts and offsets.
  if (
    (entryCount === SENTINEL_16 || directoryOffset === SENTINEL_32) &&
    eocd >= 20 &&
    view.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR
  ) {
    const recordOffset = Number(view.getBigUint64(eocd - 20 + 8, true))
    if (recordOffset + 56 <= buffer.byteLength && view.getUint32(recordOffset, true) === SIG_ZIP64_EOCD) {
      entryCount = Number(view.getBigUint64(recordOffset + 32, true))
      directoryOffset = Number(view.getBigUint64(recordOffset + 48, true))
    }
  }

  const entries: ZipEntry[] = []
  let offset = directoryOffset

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.byteLength) break
    if (view.getUint32(offset, true) !== SIG_CENTRAL) break

    const method = view.getUint16(offset + 10, true)
    let compressedSize = view.getUint32(offset + 20, true)
    let uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    let localOffset = view.getUint32(offset + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))

    // Any field that overflowed is stored 64-bit in the ZIP64 extra block, in
    // a fixed order but only for the fields that actually overflowed.
    if (
      compressedSize === SENTINEL_32 ||
      uncompressedSize === SENTINEL_32 ||
      localOffset === SENTINEL_32
    ) {
      const extraStart = offset + 46 + nameLength
      let cursor = extraStart
      const extraEnd = extraStart + extraLength
      while (cursor + 4 <= extraEnd) {
        const headerId = view.getUint16(cursor, true)
        const size = view.getUint16(cursor + 2, true)
        if (headerId === 0x0001) {
          let field = cursor + 4
          if (uncompressedSize === SENTINEL_32 && field + 8 <= extraEnd) {
            uncompressedSize = Number(view.getBigUint64(field, true)); field += 8
          }
          if (compressedSize === SENTINEL_32 && field + 8 <= extraEnd) {
            compressedSize = Number(view.getBigUint64(field, true)); field += 8
          }
          if (localOffset === SENTINEL_32 && field + 8 <= extraEnd) {
            localOffset = Number(view.getBigUint64(field, true))
          }
          break
        }
        cursor += 4 + size
      }
    }

    entries.push({
      name,
      read: async () => {
        // The central directory's field lengths are not always the local
        // header's, so re-read them from the local header before slicing.
        if (view.getUint32(localOffset, true) !== SIG_LOCAL) {
          throw new MeshParseError('This archive is damaged.')
        }
        const localNameLength = view.getUint16(localOffset + 26, true)
        const localExtraLength = view.getUint16(localOffset + 28, true)
        const start = localOffset + 30 + localNameLength + localExtraLength
        const raw = bytes.subarray(start, start + compressedSize)

        if (method === 0) return raw
        if (method !== 8) {
          throw new MeshParseError(`Unsupported compression in archive (method ${method}).`)
        }
        return inflateRaw(raw)
      },
    })

    offset += 46 + nameLength + extraLength + commentLength
  }

  if (entries.length === 0) throw new MeshParseError('This archive appears to be empty.')
  return entries
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new MeshParseError('This browser cannot decompress archives, so 3MF cannot be read here.')
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
