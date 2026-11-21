import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { getCwdState, getOriginalCwd, setCwdState, setOriginalCwd } = await import('../../bootstrap/state.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { resetSettingsCache, setCachedSettingsForSource } = await import('../settings/settingsCache.js')
const { checkWritePermissionForTool } = await import('./filesystem.js')
const { initializeToolPermissionContext } = await import('./permissionSetup.js')
const { resolveHookPermissionDecision } = await import('../../services/tools/toolHooks.js')

const root = realpathSync(mkdtempSync(join(tmpdir(), 'block-writes-test-')))
const project = join(root, 'w')
const outside = join(root, 'outside')
mkdirSync(project)
mkdirSync(outside)
const savedCwd = getCwdState()
const savedOriginalCwd = getOriginalCwd()
setOriginalCwd(project)
setCwdState(project)
afterEach(() => resetSettingsCache())
afterAll(() => {
  setOriginalCwd(savedOriginalCwd)
  setCwdState(savedCwd)
  rmSync(root, { recursive: true, force: true })
})

function context(
  mode: ToolPermissionContext['mode'],
  extra: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return {
    ...getDefaultAppState().toolPermissionContext,
    mode,
    alwaysAllowRules: { userSettings: ['Write', 'Edit', 'NotebookEdit'] },
    ...extra,
  } as ToolPermissionContext
}

const tool = (name: string) =>
  ({ name, getPath: (input: { file_path: string }) => input.file_path }) as unknown as Tool
const write = (file_path: string, ctx: ToolPermissionContext, name = 'Write') =>
  checkWritePermissionForTool(tool(name), { file_path }, ctx)

const blocked = { blockWritesOutsideWorkingDirectories: true }
const outsideFile = join(outside, 'w.txt')
const outsideMessage = `${outsideFile} is outside ${project}; the permissions.blockWritesOutsideWorkingDirectories setting blocks writes outside the working directories. Ask the user to add the directory with /add-dir, or to remove that setting.`

test('blockWritesOutsideWorkingDirectories denies file writes outside the working directories in every mode, like 2.1.329', () => {
  for (const name of ['Write', 'Edit', 'NotebookEdit']) {
    for (const mode of ['bypassPermissions', 'acceptEdits', 'dontAsk', 'default', 'plan'] as const) {
      expect(write(outsideFile, context(mode, blocked), name)).toMatchObject({
        behavior: 'deny',
        message: outsideMessage,
      })
    }
  }
})

test('blockWritesOutsideWorkingDirectories leaves the working and added directories writable', () => {
  expect(write(join(project, 'in.txt'), context('acceptEdits', blocked)).behavior).toBe('allow')
  const added = context('acceptEdits', {
    ...blocked,
    additionalWorkingDirectories: new Map([[outside, { path: outside, source: 'cliArg' }]]),
  })
  expect(write(outsideFile, added).behavior).toBe('allow')
})

test('blockWritesOutsideWorkingDirectories blocks Claude Code settings files inside the working directory', () => {
  const settingsFile = join(project, '.claude', 'settings.json')
  expect(write(settingsFile, context('bypassPermissions', blocked))).toMatchObject({
    behavior: 'deny',
    message: `${settingsFile}: Writes to Claude Code settings files are blocked while permissions.blockWritesOutsideWorkingDirectories is on, because a settings file can lift that block. While a managed settings folder cannot be resolved, any .json file counts as one.`,
  })
  expect(write(settingsFile, context('bypassPermissions')).behavior).not.toBe('deny')
})

test('an allow rule for the path does not lift blockWritesOutsideWorkingDirectories, and without the setting nothing changes', () => {
  const pathRule = { alwaysAllowRules: { userSettings: [`Edit(/${outside}/**)`] } }
  expect(write(outsideFile, context('default', pathRule)).behavior).toBe('allow')
  expect(write(outsideFile, context('default')).behavior).toBe('ask')
  expect(write(outsideFile, context('default', { ...pathRule, ...blocked }))).toMatchObject({
    behavior: 'deny',
    message: outsideMessage,
  })
})

test('blockWritesOutsideWorkingDirectories from any settings source reaches the permission context', async () => {
  const init = async () =>
    (
      await initializeToolPermissionContext({
        allowedToolsCli: [],
        disallowedToolsCli: [],
        permissionMode: 'default',
        allowDangerouslySkipPermissions: false,
        addDirs: [],
      })
    ).toolPermissionContext
  expect((await init()).blockWritesOutsideWorkingDirectories ?? false).toBe(false)
  for (const source of ['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings'] as const) {
    resetSettingsCache()
    setCachedSettingsForSource(source, { permissions: { blockWritesOutsideWorkingDirectories: true } })
    expect((await init()).blockWritesOutsideWorkingDirectories).toBe(true)
  }
  resetSettingsCache()
  setCachedSettingsForSource('userSettings', { permissions: { blockWritesOutsideWorkingDirectories: true } })
  setCachedSettingsForSource('projectSettings', { permissions: { blockWritesOutsideWorkingDirectories: false } })
  expect((await init()).blockWritesOutsideWorkingDirectories).toBe(true)
})

test('a tool.check mod cannot lift the block either', async () => {
  const resolve = async (file_path: string, permission: Partial<ToolPermissionContext>) => {
    const initial = getDefaultAppState()
    const state = { ...initial, toolPermissionContext: context('default', permission) }
    const toolUseContext = {
      getAppState: () => state,
      setAppState: () => {},
      abortController: new AbortController(),
      messages: [],
      options: { isNonInteractiveSession: false, tools: [] },
      modsSnapshot: {
        hasHooks: () => true,
        dispatch: async (_event: string, _input: unknown, _core: unknown, options: { onHooks?: (hooks: { plugin: string }[]) => void }) => {
          options.onHooks?.([{ plugin: 'lifter' }])
          return { decision: 'allow' }
        },
      },
    } as unknown as ToolUseContext
    const fileTool = {
      name: 'Write',
      inputSchema: z.object({}).passthrough(),
      isReadOnly: () => false,
      getPath: (input: { file_path: string }) => input.file_path,
      checkPermissions: async (input: { file_path: string }, ctx: ToolUseContext) =>
        checkWritePermissionForTool(fileTool, input, ctx.getAppState().toolPermissionContext),
    } as unknown as Tool
    const { decision } = await resolveHookPermissionDecision(
      undefined, fileTool, { file_path }, toolUseContext,
      async () => ({ behavior: 'ask', message: 'prompted' }),
      { message: { id: 'msg_test' } } as never, 'toolu_test',
    )
    return decision.behavior
  }
  const noRules = { alwaysAllowRules: {} }
  expect(await resolve(outsideFile, noRules)).toBe('allow')
  expect(await resolve(outsideFile, { ...noRules, ...blocked })).toBe('deny')
  expect(await resolve(join(project, '.claude', 'settings.json'), { ...noRules, ...blocked })).toBe('deny')
})
