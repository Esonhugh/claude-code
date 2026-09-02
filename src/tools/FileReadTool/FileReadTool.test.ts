import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { FileStateCache } from '../../utils/fileStateCache.js'
import { FileReadTool } from './FileReadTool.js'

const toolUseContext = {
  getAppState: () => ({
    ...getDefaultAppState(),
    toolPermissionContext: getEmptyToolPermissionContext(),
  }),
}

test('treats an empty optional PDF page range as omitted', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'file-read-tool-test-'))
  const filePath = join(tempDir, 'empty-pages.txt')
  try {
    writeFileSync(filePath, 'readable text\n')

    assert.deepEqual(
      await FileReadTool.validateInput(
        { file_path: filePath, pages: '' },
        toolUseContext as never,
      ),
      { result: true },
    )
    assert.deepEqual(
      await FileReadTool.validateInput(
        { file_path: filePath, pages: ' \t ' },
        toolUseContext as never,
      ),
      { result: true },
    )

    const result = await FileReadTool.call(
      { file_path: filePath, pages: '' },
      {
        ...toolUseContext,
        abortController: new AbortController(),
        readFileState: new FileStateCache(100, 1_000_000),
      } as never,
    )

    assert.equal(result.data.type, 'text')
    assert.equal(result.data.file.content, 'readable text\n')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('reads supported image files as base64 image data', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'file-read-tool-image-test-'))
  const images = [
    {
      extension: 'png',
      mediaType: 'image/png',
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=',
    },
    {
      extension: 'jpg',
      mediaType: 'image/jpeg',
      base64:
        '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAFn/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=',
    },
    {
      extension: 'gif',
      mediaType: 'image/gif',
      base64: 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
    },
    {
      extension: 'webp',
      mediaType: 'image/webp',
      base64: 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAA==',
    },
  ]

  try {
    for (const image of images) {
      const filePath = join(tempDir, `pixel.${image.extension}`)
      const imageBuffer = Buffer.from(image.base64, 'base64')
      writeFileSync(filePath, imageBuffer)

      const result = await FileReadTool.call(
        { file_path: filePath },
        {
          ...toolUseContext,
          abortController: new AbortController(),
          readFileState: new FileStateCache(100, 1_000_000),
        } as never,
      )

      assert.equal(result.data.type, 'image')
      if (result.data.type !== 'image') assert.fail('Expected image output')
      assert.equal(result.data.file.type, image.mediaType)
      assert.equal(result.data.file.originalSize, imageBuffer.length)
      assert.deepEqual(Buffer.from(result.data.file.base64, 'base64'), imageBuffer)
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('normalizes an over-limit PDF page range in the error', async () => {
  const result = await FileReadTool.validateInput(
    { file_path: '/tmp/read-too-many-pages.pdf', pages: ' 1-21 ' },
    toolUseContext as never,
  )

  assert.equal(result.result, false)
  assert.equal(result.errorCode, 8)
  assert.match(result.message ?? '', /Page range "1-21" exceeds maximum/)
})

test('rejects a non-empty invalid PDF page range', async () => {
  const result = await FileReadTool.validateInput(
    { file_path: '/tmp/read-invalid-pages.txt', pages: '0' },
    toolUseContext as never,
  )

  assert.equal(result.result, false)
  assert.match(result.message ?? '', /Invalid pages parameter: "0"/)
})
