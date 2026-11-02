import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolPermissionContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { getCwdState, getOriginalCwd, setCwdState, setOriginalCwd, setRestrictedSession } = await import(
  '../../bootstrap/state.js'
)
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { checkReadPermissionForTool, checkWritePermissionForTool } = await import('./filesystem.js')
const { initializeToolPermissionContext } = await import('./permissionSetup.js')
const { isAutoMemoryEnabled } = await import('../../memdir/paths.js')

const root = realpathSync(mkdtempSync(join(tmpdir(), 'restricted-test-')))
const project = join(root, 'w')
const savedCwd = getCwdState()
const savedOriginalCwd = getOriginalCwd()
setOriginalCwd(project)
setCwdState(project)
setRestrictedSession(true)
afterAll(() => {
  setRestrictedSession(false)
  setOriginalCwd(savedOriginalCwd)
  setCwdState(savedCwd)
  rmSync(root, { recursive: true, force: true })
})

function context(mode: ToolPermissionContext['mode'], allow: string[] = []): ToolPermissionContext {
  return {
    ...getDefaultAppState().toolPermissionContext,
    mode,
    alwaysAllowRules: { session: allow },
  } as ToolPermissionContext
}

const tool = (name: string) =>
  ({ name, getPath: (input: { file_path: string }) => input.file_path }) as unknown as Tool

const outsideMessage = `${join(root, 'out.txt')} is outside ${project}; --restricted confines the file tools to the working directory.`

test('--restricted denies the code-running tools and WebFetch unless --tools names them, like 2.1.311', async () => {
  const run = (baseToolsCli?: string[]) =>
    initializeToolPermissionContext({
      allowedToolsCli: [],
      disallowedToolsCli: [],
      baseToolsCli,
      permissionMode: 'default',
      allowDangerouslySkipPermissions: true,
      addDirs: [],
    })
  const { toolPermissionContext } = await run()
  const denied = toolPermissionContext.alwaysDenyRules.cliArg ?? []
  const { getAllBaseTools } = await import('../../tools.js')
  const known = new Set(getAllBaseTools().map(tool => tool.name))
  for (const name of ['Bash', 'PowerShell', 'Terminal', 'REPL', 'Monitor', 'CronCreate', 'Workflow', 'RemoteTrigger', 'WebFetch'].filter(n => known.has(n)))
    expect(denied).toContain(name)
  expect(denied).toEqual(expect.arrayContaining(['Bash', 'WebFetch', 'Workflow']))
  expect(denied).not.toContain('Read')
  expect(toolPermissionContext.isBypassPermissionsModeAvailable).toBe(false)

  const kept = (await run(['Bash', 'Read'])).toolPermissionContext.alwaysDenyRules.cliArg ?? []
  expect(kept).not.toContain('Bash')
  expect(kept).toContain('WebFetch')
})

test('--restricted denies file reads and writes outside the working directory', () => {
  const outside = { file_path: join(root, 'out.txt') }
  const read = checkReadPermissionForTool(tool('Read'), outside, context('default'))
  expect(read.behavior).toBe('deny')
  expect(read.behavior === 'deny' && read.message).toBe(outsideMessage)

  const write = checkWritePermissionForTool(tool('Write'), outside, context('acceptEdits'))
  expect(write.behavior).toBe('deny')
  expect(write.behavior === 'deny' && write.message).toBe(outsideMessage)

  expect(checkReadPermissionForTool(tool('Read'), { file_path: join(project, 'in.txt') }, context('default')).behavior).toBe('allow')
  expect(checkWritePermissionForTool(tool('Write'), { file_path: join(project, 'new.txt') }, context('acceptEdits')).behavior).toBe('allow')
})

test('--restricted honours allow rules outside the working directory', () => {
  const ctx = context('default', [`Read(/${root}/**)`, `Write(/${root}/**)`])
  expect(checkReadPermissionForTool(tool('Read'), { file_path: join(root, 'out.txt') }, ctx).behavior).toBe('allow')
})

test('--restricted keeps settings and git writes for a person to approve', () => {
  const result = checkWritePermissionForTool(
    tool('Edit'),
    { file_path: join(project, '.git', 'x') },
    context('acceptEdits', ['Edit']),
  )
  expect(result.behavior).toBe('ask')
  expect(result.behavior === 'ask' && result.decisionReason).toMatchObject({ type: 'safetyCheck', classifierApprovable: false })
})

test('--restricted turns auto-memory off', () => {
  expect(isAutoMemoryEnabled()).toBe(false)
})
