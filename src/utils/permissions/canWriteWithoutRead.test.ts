import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
process.env.NODE_ENV = 'test'
const project = realpathSync(mkdtempSync(join(tmpdir(), 'cc-read-guard-')))
mkdirSync(join(project, '.git'), { recursive: true })
const bootstrap = await import('../../bootstrap/state.js')
bootstrap.setOriginalCwd(project)
bootstrap.setCwdState(project)
const { setSessionSettingsCache } = await import('../settings/settingsCache.js')
setSessionSettingsCache({ settings: {}, errors: [] })
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { FileReadTool } = await import('../../tools/FileReadTool/FileReadTool.js')
const { FileWriteTool } = await import('../../tools/FileWriteTool/FileWriteTool.js')
const { FileEditTool } = await import('../../tools/FileEditTool/FileEditTool.js')
afterAll(() => rmSync(project, { recursive: true, force: true }))

type Opts = {
  mode?: ToolPermissionContext['mode']
  model?: string
  withRead?: boolean
  readFileState?: Map<string, unknown>
}
function contextFor({ mode = 'acceptEdits', model = 'claude-sonnet-5-5', withRead = true, readFileState = new Map() }: Opts = {}) {
  const initial = getDefaultAppState()
  const state = {
    ...initial,
    toolPermissionContext: {
      ...initial.toolPermissionContext,
      mode,
      isBypassPermissionsModeAvailable: mode === 'bypassPermissions',
    } as ToolPermissionContext,
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
      mainLoopModel: model,
      tools: withRead ? [FileReadTool, FileWriteTool, FileEditTool] : [FileWriteTool, FileEditTool],
    },
  } as unknown as ToolUseContext
}
const parent = { uuid: 'parent' } as never
const fresh = (name: string, text = 'old line\n') => {
  const path = join(project, name)
  writeFileSync(path, text)
  return path
}
const NOT_READ = 'File has not been read yet. Read it first before writing to it.'

test('Write overwrites an unread file when the write needs no prompt', async () => {
  const path = fresh('w1.txt')
  const context = contextFor()
  expect(await FileWriteTool.validateInput!({ file_path: path, content: 'new\n' }, context)).toEqual({ result: true })
  await FileWriteTool.call({ file_path: path, content: 'new\n' }, context, undefined as never, parent)
  expect(readFileSync(path, 'utf8')).toBe('new\n')
})

test.each([
  ['default mode asks for the write', { mode: 'default' as const }],
  ['legacy model keeps the guard', { model: 'claude-sonnet-4-5-20250929' }],
  ['session without Read keeps the guard', { withRead: false }],
])('Write keeps the read guard: %s', async (_name, opts) => {
  const path = fresh('w2.txt')
  const result = await FileWriteTool.validateInput!({ file_path: path, content: 'x' }, contextFor(opts))
  expect(result).toMatchObject({ result: false, message: NOT_READ })
})

test('Write keeps the read guard for notebooks and partial reads', async () => {
  const notebook = fresh('n.ipynb', '{}')
  expect(await FileWriteTool.validateInput!({ file_path: notebook, content: '{}' }, contextFor()))
    .toMatchObject({ result: false, message: NOT_READ })
  const path = fresh('w3.txt')
  const partial = new Map([[path, { content: 'old', timestamp: Date.now() + 10_000, offset: 1, limit: 1, isPartialView: true }]])
  expect(await FileWriteTool.validateInput!({ file_path: path, content: 'x' }, contextFor({ readFileState: partial })))
    .toMatchObject({ result: false, message: NOT_READ })
})

test('bypassPermissions writes an unread in-project file', async () => {
  const path = fresh('w4.txt')
  expect(await FileWriteTool.validateInput!({ file_path: path, content: 'x' }, contextFor({ mode: 'bypassPermissions' })))
    .toEqual({ result: true })
})

test('Edit applies to an unread file when old_string still matches', async () => {
  const path = fresh('e1.txt')
  const context = contextFor()
  const input = { file_path: path, old_string: 'old line', new_string: 'new line' }
  expect(await FileEditTool.validateInput!(input, context)).toMatchObject({ result: true })
  await FileEditTool.call(input, context, undefined as never, parent)
  expect(readFileSync(path, 'utf8')).toBe('new line\n')
  expect(await FileEditTool.validateInput!({ ...input, file_path: fresh('e2.txt'), old_string: 'missing' }, contextFor()))
    .toMatchObject({ result: false, message: NOT_READ })
  expect(await FileEditTool.validateInput!({ ...input, file_path: fresh('e3.txt') }, contextFor({ mode: 'default' })))
    .toMatchObject({ result: false, message: NOT_READ })
})

test('Edit recovers a stale read when old_string still matches', async () => {
  const path = fresh('e4.txt', 'old line\nmore\n')
  const past = new Date(Date.now() - 60_000)
  utimesSync(path, past, past)
  const stale = () => new Map([[path, { content: 'old line\n', timestamp: past.getTime() - 60_000, offset: undefined, limit: undefined }]])
  const input = { file_path: path, old_string: 'old line', new_string: 'new line' }
  expect(await FileEditTool.validateInput!(input, contextFor({ mode: 'default', readFileState: stale() })))
    .toMatchObject({ result: false, errorCode: 7 })
  const context = contextFor({ readFileState: stale() })
  expect(await FileEditTool.validateInput!(input, context)).toMatchObject({ result: true })
  await FileEditTool.call(input, context, undefined as never, parent)
  expect(readFileSync(path, 'utf8')).toBe('new line\nmore\n')
})
