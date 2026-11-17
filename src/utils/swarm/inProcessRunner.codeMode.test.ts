import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetStateForTests, setIsInteractive } from '../../bootstrap/state.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { getEmptyToolPermissionContext, type Tool, type ToolUseContext, type Tools } from '../../Tool.js'
import { resetCodeModeGateForTesting, settleCodeModeGate } from '../../tools/REPLTool/codeModeGate.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { createTeammateContext } from '../teammateContext.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test', ISSUES_EXPLAINER: 'report an issue' }
const { getSystemPrompt } = await import('../../constants/prompts.js')
const { getTeammateDefaultSystemPrompt } = await import('./inProcessRunner.js')

const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_REPL', 'CLAUDE_REPL_MODE', 'USER_TYPE']
let saved: (string | undefined)[]
let root: string

const pool: Tools = ['REPL', 'Poll', 'Write', 'Edit', 'TodoWrite'].map(name => ({ name }) as Tool)
const ORDINARY = 'Prefer dedicated tools over Bash'

beforeEach(async () => {
  saved = keys.map(key => process.env[key])
  root = await realpath(await mkdtemp(join(tmpdir(), 'teammate-code-mode-')))
  for (const key of keys) delete process.env[key]
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.ANTHROPIC_API_KEY = 'sk-code-mode-placeholder'
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  resetSettingsCache()
  resetStateForTests()
  resetCodeModeGateForTesting()
  clearSystemPromptSections()
})

afterEach(async () => {
  resetSettingsCache()
  resetStateForTests()
  resetCodeModeGateForTesting()
  clearSystemPromptSections()
  keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  await rm(root, { recursive: true, force: true })
})

test("a Code Mode leader's teammate gets the ordinary system prompt (D3)", async () => {
  process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  setIsInteractive(true)
  expect(settleCodeModeGate({ remoteControl: false, remote: false }).enabled).toBe(true)

  const leader = (await getSystemPrompt(pool, 'claude-sonnet-4-5-20250929')).join('\n')
  expect(leader).not.toContain(ORDINARY)

  const teammate = createTeammateContext({
    agentId: 'w@t',
    agentName: 'w',
    teamName: 't',
    planModeRequired: false,
    parentSessionId: 'leader',
    abortController: new AbortController(),
  })
  const context = {
    options: { tools: pool, mainLoopModel: 'claude-sonnet-4-5-20250929', mcpClients: [] },
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as unknown as Pick<ToolUseContext, 'options' | 'getAppState'>
  const prompt = (await getTeammateDefaultSystemPrompt(teammate, context)).join('\n')
  expect(prompt).toContain(ORDINARY)
  expect(prompt).not.toContain('REPL script')
})
