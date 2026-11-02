import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readImageHeaderDimensions } from './imageResizer.js'

const png = (width: number, height: number) => {
  const buffer = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer)
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

test('reads dimensions from PNG, GIF, JPEG and WebP headers like 2.1.311', () => {
  expect(readImageHeaderDimensions(png(640, 480))).toEqual({ width: 640, height: 480 })
  const gif = Buffer.alloc(10)
  gif.write('GIF89a')
  gif.writeUInt16LE(32, 6)
  gif.writeUInt16LE(16, 8)
  expect(readImageHeaderDimensions(gif)).toEqual({ width: 32, height: 16 })
  // SOI, then an SOF0 segment: length 17, precision 8, height 200, width 300.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xc8, 0x01, 0x2c, 0x03, 0, 0, 0, 0])
  expect(readImageHeaderDimensions(jpeg)).toEqual({ width: 300, height: 200 })
  const webp = Buffer.alloc(30)
  webp.write('RIFF')
  webp.write('WEBPVP8X', 8)
  webp.writeUIntLE(99, 24, 3)
  webp.writeUIntLE(49, 27, 3)
  expect(readImageHeaderDimensions(webp)).toEqual({ width: 100, height: 50 })
  expect(readImageHeaderDimensions(Buffer.from('\x89PNG\r\n'))).toBeUndefined()
})

// Runs in its own process: loading the image processor here would cache it
// for other test files that mock it.
test('an image whose header cannot be read is refused instead of sent as is', () => {
  const script = `
    const { maybeResizeAndDownsampleImageBuffer } = await import(${JSON.stringify(new URL('./imageResizer.ts', import.meta.url).pathname)})
    const truncated = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    try {
      await maybeResizeAndDownsampleImageBuffer(truncated, truncated.length, 'png')
      console.log('sent as is')
    } catch (error) {
      console.log(error.name + ': ' + error.message)
    }
  `
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } })
  expect(result.stdout.trim()).toBe(
    'ImageResizeError: Unable to resize image — image processing is unavailable and dimensions could not be read from the file header. Please convert the image to PNG, JPEG, GIF, or WebP.',
  )
})
