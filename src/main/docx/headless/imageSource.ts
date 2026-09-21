import { existsSync, readFileSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'

export interface ImageSource {
  bytes: Uint8Array
  ext: string
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | null
  width: number
  height: number
}

/** Pixel size from the header of a PNG, JPEG or GIF; null for anything else. 1:1 GenOffice image-size. */
export function imageSize(
  bytes: Uint8Array,
): { width: number; height: number; mime: 'image/png' | 'image/jpeg' | 'image/gif' } | null {
  const b = bytes
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: readU32(b, 16), height: readU32(b, 20), mime: 'image/png' }
  }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8), mime: 'image/gif' }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]!
      const size = (b[i + 2]! << 8) | b[i + 3]!
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC) carry the frame size
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: (b[i + 5]! << 8) | b[i + 6]!,
          width: (b[i + 7]! << 8) | b[i + 8]!,
          mime: 'image/jpeg',
        }
      }
      i += 2 + size
    }
  }
  return null
}

function readU32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
}

/**
 * Image bytes for an insert_image / insert_picture / set_watermark(image)
 * field in headless mode: a data: URL, an http(s) URL, or a local path
 * (absolute, else relative to the ops base directory — the GenOffice CLI's
 * widened source set; the live editor only takes http(s)/data:).
 */
export async function readImageSource(url: string, baseDir?: string): Promise<ImageSource | null> {
  if (url.startsWith('data:')) {
    const m = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/is.exec(url)
    if (!m) return null
    return withType(new Uint8Array(Buffer.from(m[2]!, 'base64')), m[1]!.toLowerCase())
  }
  if (/^https?:\/\//i.test(url)) {
    try {
      const resp = await fetch(url)
      if (!resp.ok) return null
      return withType(new Uint8Array(await resp.arrayBuffer()), '')
    } catch {
      return null
    }
  }
  const candidates = isAbsolute(url)
    ? [url]
    : [resolve(process.cwd(), url), ...(baseDir ? [resolve(baseDir, url)] : [])]
  const path = candidates.find((p) => existsSync(p))
  if (!path) return null
  return withType(new Uint8Array(readFileSync(path)), extname(path).slice(1).toLowerCase())
}

/** Sniffed type wins over what the name or header claims (a .jpg holding PNG bytes is common). */
function withType(bytes: Uint8Array, declared: string): ImageSource | null {
  const size = imageSize(bytes)
  if (!size) return null
  const ext =
    size.mime === 'image/png'
      ? 'png'
      : size.mime === 'image/jpeg'
        ? 'jpg'
        : size.mime === 'image/gif'
          ? 'gif'
          : declared === 'jpeg'
            ? 'jpg'
            : declared || 'png'
  return { bytes, ext, mime: size.mime, width: size.width, height: size.height }
}
