import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
process.env.NODE_ENV = 'test'
const project = realpathSync(mkdtempSync(join(tmpdir(), 'cc-file-type-')))
mkdirSync(join(project, '.git'), { recursive: true })
const bootstrap = await import('../../bootstrap/state.js')
bootstrap.setOriginalCwd(project)
bootstrap.setCwdState(project)
const { setSessionSettingsCache } = await import('../../utils/settings/settingsCache.js')
setSessionSettingsCache({ settings: {}, errors: [] })
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { FileReadTool } = await import('../FileReadTool/FileReadTool.js')
const { FileWriteTool } = await import('./FileWriteTool.js')
const { FileEditTool } = await import('../FileEditTool/FileEditTool.js')
const { NotebookEditTool } = await import('../NotebookEditTool/NotebookEditTool.js')
afterAll(() => rmSync(project, { recursive: true, force: true }))

function context(readFileState = new Map()) {
  const initial = getDefaultAppState()
  const state = {
    ...initial,
    toolPermissionContext: { ...initial.toolPermissionContext, mode: 'acceptEdits' } as ToolPermissionContext,
  }
  return {
    getAppState: () => state,
    setAppState: () => {},
    abortController: new AbortController(),
    messages: [],
    readFileState,
    updateFileHistoryState: () => {},
    options: {
      isNonInteractiveSession: true,
      mainLoopModel: 'claude-sonnet-5-5',
      tools: [FileReadTool, FileWriteTool, FileEditTool, NotebookEditTool],
    },
  } as unknown as ToolUseContext
}
const parent = { uuid: 'parent' } as never
const NOT_UTF8 = 'File is not valid UTF-8: it uses a legacy encoding such as Windows-1252, Shift-JIS or GBK, or it is binary.'

test('Write refuses a directory and a non-regular file like 2.1.311', async () => {
  const dir = join(project, 'sub')
  mkdirSync(dir)
  expect(await FileWriteTool.validateInput!({ file_path: dir, content: 'x' }, context())).toEqual({
    result: false,
    message: `${dir} is a directory, not a file. To create a file inside it, include the file name in file_path.`,
    errorCode: 17,
  })
  if (process.platform !== 'win32') {
    expect(await FileWriteTool.validateInput!({ file_path: '/dev/null', content: 'x' }, context())).toEqual({
      result: false,
      message: '/dev/null exists but is not a regular file (a device, FIFO or socket). Write only creates or overwrites regular files.',
      errorCode: 18,
    })
  }
})

test('Edit and Write refuse files that are not UTF-8 text instead of rewriting them', async () => {
  const binary = join(project, 'bad.png')
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0xff, 0xfe, 0x41])
  writeFileSync(binary, bytes)
  const edit = await FileEditTool.validateInput!({ file_path: binary, old_string: 'PNG', new_string: 'x', replace_all: false }, context())
  expect(edit).toMatchObject({ result: false })
  expect((edit as { message: string }).message.startsWith(NOT_UTF8)).toBe(true)

  await expect(FileWriteTool.call({ file_path: binary, content: 'x' }, context(), undefined as never, parent)).rejects.toThrow(NOT_UTF8)
  expect(readFileSync(binary)).toEqual(bytes)

  const nul = join(project, 'nul.txt')
  writeFileSync(nul, Buffer.from('a\0b'))
  const nulEdit = await FileEditTool.validateInput!({ file_path: nul, old_string: 'a', new_string: 'x', replace_all: false }, context())
  expect((nulEdit as { message: string }).message).toStartWith('File has NUL bytes in its first 8 KB')

  const utf16be = join(project, 'be.txt')
  writeFileSync(utf16be, Buffer.from([0xfe, 0xff, 0x00, 0x41]))
  const beEdit = await FileEditTool.validateInput!({ file_path: utf16be, old_string: 'A', new_string: 'x', replace_all: false }, context())
  expect((beEdit as { message: string }).message).toStartWith('File is UTF-16 big-endian (it starts FE FF)')

  // UTF-16LE behind its byte-order mark stays editable.
  const utf16le = join(project, 'le.txt')
  writeFileSync(utf16le, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('old', 'utf16le')]))
  expect(await FileEditTool.validateInput!({ file_path: utf16le, old_string: 'old', new_string: 'new', replace_all: false }, context()))
    .toMatchObject({ result: true })
})

test('NotebookEdit refuses a notebook that is not UTF-8', async () => {
  const notebook = join(project, 'bad.ipynb')
  writeFileSync(notebook, Buffer.from([0x7b, 0xff, 0x7d]))
  const readFileState = new Map([[notebook, { content: '{}', timestamp: Date.now() + 10_000, offset: undefined, limit: undefined }]])
  const result = await NotebookEditTool.validateInput!({ notebook_path: notebook, new_source: 'x', edit_mode: 'insert', cell_type: 'code' }, context(readFileState))
  expect(result).toMatchObject({ result: false, errorCode: 15 })
  expect((result as { message: string }).message.startsWith(NOT_UTF8)).toBe(true)
})
