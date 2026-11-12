import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const project = realpathSync(mkdtempSync(join(tmpdir(), 'cc-grep-count-')))
writeFileSync(join(project, 'a.txt'), 'x1\nx2\ny\n')
writeFileSync(join(project, 'b.txt'), 'x3\n')
const bootstrap = await import('../../bootstrap/state.js')
bootstrap.setOriginalCwd(project)
bootstrap.setCwdState(project)
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { GrepTool } = await import('./GrepTool.js')
afterAll(() => rmSync(project, { recursive: true, force: true }))

const context = {
  getAppState: () => getDefaultAppState(),
  abortController: new AbortController(),
  options: {},
} as unknown as ToolUseContext

test('count mode totals a single file the same way as a directory', async () => {
  const file = await GrepTool.call({ pattern: 'x', path: join(project, 'a.txt'), output_mode: 'count' }, context)
  expect(file.data).toMatchObject({ numMatches: 2, numFiles: 1, content: 'a.txt:2' })
  const dir = await GrepTool.call({ pattern: 'x', path: project, output_mode: 'count' }, context)
  expect(dir.data).toMatchObject({ numMatches: 3, numFiles: 2 })
})
