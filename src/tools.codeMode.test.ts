import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from './Tool.js'
import { getIsInteractive, setIsInteractive } from './bootstrap/state.js'
import { resetSettingsCache, setSessionSettingsCache } from './utils/settings/settingsCache.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
  ISSUES_EXPLAINER: 'report an issue',
}

const { getAllBaseTools, getREPLTool, getTools } = await import('./tools.js')
const { hideCodeModeOnlyTools, noteReplLaunchPermissionMode, resetCodeModeGateForTesting } = await import(
  './tools/REPLTool/codeModeGate.js'
)
const { CODE_MODE_ONLY_TOOLS, isReplModeEnabled } = await import('./tools/REPLTool/constants.js')
const { getReplPrimitiveTools } = await import('./tools/REPLTool/primitiveTools.js')

const envKeys = [
  'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_REPL',
  'CLAUDE_REPL_MODE',
] as const
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
const savedInteractive = getIsInteractive()

const names = (tools: readonly { name: string }[]) => tools.map(tool => tool.name)

beforeEach(() => {
  for (const key of envKeys) delete process.env[key]
  setSessionSettingsCache({ settings: {}, errors: [] })
  setIsInteractive(true)
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  resetCodeModeGateForTesting()
})

afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setIsInteractive(savedInteractive)
  resetSettingsCache()
  resetCodeModeGateForTesting()
})

describe('tool pool with Code Mode off', () => {
  test('keeps the ordinary tools and adds no REPL', () => {
    expect(isReplModeEnabled()).toBe(false)
    expect(getREPLTool()).toBeNull()
    const pool = getTools(getEmptyToolPermissionContext())
    const poolNames = names(pool)
    expect(poolNames).not.toContain('REPL')
    expect(poolNames).not.toContain('Poll')
    for (const name of ['Read', 'Write', 'Edit', 'Bash', 'NotebookEdit'])
      expect(poolNames).toContain(name)
    expect(names(getAllBaseTools())).not.toContain('REPL')
    // The API list is the pool itself, by identity.
    expect(hideCodeModeOnlyTools(pool)).toBe(pool)
  })

  test('simple mode keeps Bash, Read and Edit', () => {
    process.env.CLAUDE_CODE_SIMPLE = '1'
    expect(names(getTools(getEmptyToolPermissionContext()))).toEqual(
      expect.arrayContaining(['Bash', 'Read', 'Edit']),
    )
    expect(names(getTools(getEmptyToolPermissionContext()))).not.toContain('REPL')
  })
})

describe('tool pool with Code Mode on', () => {
  test('loads the real REPL and takes CODE_MODE_ONLY_TOOLS out of the pool', () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
    resetCodeModeGateForTesting()
    expect(isReplModeEnabled()).toBe(true)
    const repl = getREPLTool()
    expect(repl?.name).toBe('REPL')
    expect(repl?.aliases).toEqual(['Eval'])
    const pool = getTools(getEmptyToolPermissionContext())
    const poolNames = names(pool)
    expect(poolNames).toContain('REPL')
    expect(poolNames).not.toContain('Poll')
    for (const name of CODE_MODE_ONLY_TOOLS) expect(poolNames).not.toContain(name)
    // Write and Edit stay in the pool; the API list carries only REPL (and Poll, StructuredOutput).
    expect(poolNames).toEqual(expect.arrayContaining(['Write', 'Edit']))
    expect(names(hideCodeModeOnlyTools(pool))).toEqual(['REPL'])
  })

  test('Poll joins only a session launched in auto or bypassPermissions', () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
    resetCodeModeGateForTesting()
    for (const mode of ['default', 'acceptEdits', 'plan'] as const) noteReplLaunchPermissionMode(mode)
    expect(names(hideCodeModeOnlyTools(getTools(getEmptyToolPermissionContext())))).toEqual(['REPL'])
    noteReplLaunchPermissionMode('bypassPermissions')
    expect(names(hideCodeModeOnlyTools(getTools(getEmptyToolPermissionContext())))).toEqual(['REPL', 'Poll'])
  })

  test('the launch mode asks for nothing with Code Mode off', () => {
    noteReplLaunchPermissionMode('auto')
    expect(names(getTools(getEmptyToolPermissionContext()))).not.toContain('Poll')
  })
})

describe('REPL primitives', () => {
  test('carry no Agent tool', () => {
    expect(names(getReplPrimitiveTools())).not.toContain('Agent')
    expect(names(getReplPrimitiveTools())).toEqual(
      expect.arrayContaining(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'NotebookEdit']),
    )
  })
})
