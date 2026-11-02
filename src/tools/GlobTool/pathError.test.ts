import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const project = realpathSync(mkdtempSync(join(tmpdir(), 'cc-search-path-')))
writeFileSync(join(project, 'a.txt'), 'x\n')
const bootstrap = await import('../../bootstrap/state.js')
bootstrap.setOriginalCwd(project)
bootstrap.setCwdState(project)
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { GlobTool } = await import('./GlobTool.js')
const { GrepTool } = await import('../GrepTool/GrepTool.js')
afterAll(() => rmSync(project, { recursive: true, force: true }))

const context = {
  getAppState: () => getDefaultAppState(),
  abortController: new AbortController(),
  options: {},
} as unknown as ToolUseContext

// Like 2.1.311 a bad search path is a tool error, not an input validation
// error, so the model sees it without the <tool_use_error> wrapper.
test('Glob reports a missing or non-directory path when it runs', async () => {
  const missing = join(project, 'nope')
  await expect(GlobTool.call({ pattern: '*', path: missing }, context))
    .rejects.toThrow(`Directory does not exist: ${missing}. Note: your current working directory is ${project}.`)
  const file = join(project, 'a.txt')
  await expect(GlobTool.call({ pattern: '*', path: file }, context))
    .rejects.toThrow(`Path is not a directory: ${file}`)
})

test('Grep reports a missing path when it runs', async () => {
  const missing = join(project, 'nope')
  await expect(GrepTool.call({ pattern: 'x', path: missing }, context))
    .rejects.toThrow(`Path does not exist: ${missing}. Note: your current working directory is ${project}.`)
})
