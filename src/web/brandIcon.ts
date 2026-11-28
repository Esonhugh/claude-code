import { createHash } from 'crypto'
import { constants } from 'fs'
import { lstat, open, realpath } from 'fs/promises'
import { join } from 'path'
import { loadSharp } from '../tools/FileReadTool/imageProcessor.js'

export const BRAND_ICON_PATH = '/api/brand-icon.png'
const MAX_BYTES = 1024 * 1024
const MAX_EDGE = 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export async function loadBrandIcon(configDir: string, mode: 'web' | 'desktop') {
  try {
    const dir = join(await realpath(configDir), mode)
    const path = join(dir, 'icon.png')
    // The configured root is trusted; neither of its two icon path components is.
    const parent = await lstat(dir)
    if (!parent.isDirectory()) return
    const entry = await lstat(path)
    if (!entry.isFile() || entry.nlink !== 1 || entry.size > MAX_BYTES) return

    const flags = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK
    const file = await open(path, constants.O_RDONLY | flags)
    let input: Buffer
    try {
      const [stat, currentEntry, currentParent] = await Promise.all([file.stat(), lstat(path), lstat(dir)])
      if (
        !stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES ||
        !currentEntry.isFile() || currentEntry.dev !== stat.dev || currentEntry.ino !== stat.ino ||
        !currentParent.isDirectory() || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino
      ) return
      // Bound the read independently of stat, even if an editor rewrites the file.
      const bytes = Buffer.allocUnsafe(MAX_BYTES + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      if (length > MAX_BYTES) return
      input = bytes.subarray(0, length)
    } finally {
      await file.close()
    }
    if (!input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return

    const sharp = await loadSharp<typeof import('sharp')>()
    const image = sharp(input, { failOn: 'warning', limitInputPixels: MAX_EDGE ** 2 })
    const { width, height, format } = await image.metadata()
    if (format !== 'png' || !width || !height || width > MAX_EDGE || height > MAX_EDGE) return
    const size = Math.min(128, Math.max(width, height))
    // Re-encode rather than serve the original bytes: no source metadata or trailing data.
    const body = await image.resize(size, size, { fit: 'contain', background: '#00000000' }).png().toBuffer()
    const version = createHash('sha256').update(body).digest('hex').slice(0, 16)
    return { url: `${BRAND_ICON_PATH}?v=${version}`, body }
  } catch {
    // An absent, unreadable or invalid override is equivalent to the built-in brand.
  }
}
