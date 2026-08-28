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

test('rejects a non-empty invalid PDF page range', async () => {
  const result = await FileReadTool.validateInput(
    { file_path: '/tmp/read-invalid-pages.txt', pages: '0' },
    toolUseContext as never,
  )

  assert.equal(result.result, false)
  assert.match(result.message ?? '', /Invalid pages parameter: "0"/)
})
