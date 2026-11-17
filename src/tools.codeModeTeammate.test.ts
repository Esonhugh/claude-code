import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getIsInteractive, setIsInteractive } from './bootstrap/state.js'
import { createTeammateContext, runWithTeammateContext } from './utils/teammateContext.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
  ISSUES_EXPLAINER: 'report an issue',
}

const { getREPLTool } = await import('./tools.js')
const { resetCodeModeGateForTesting, settleCodeModeGate } = await import('./tools/REPLTool/codeModeGate.js')

const envKeys = ['CLAUDE_CODE_EXPERIMENTAL_CODE_MODE', 'CLAUDE_CODE_ENTRYPOINT', 'USER_TYPE'] as const
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
const savedInteractive = getIsInteractive()

beforeEach(() => {
  for (const key of envKeys) delete process.env[key]
  resetCodeModeGateForTesting()
})

afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setIsInteractive(savedInteractive)
  resetCodeModeGateForTesting()
})

test('an in-process teammate gets no REPL tool after a Code Mode leader cached it', () => {
  process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  setIsInteractive(true)
  expect(settleCodeModeGate({ remoteControl: false, remote: false }).enabled).toBe(true)
  const leaderRepl = getREPLTool()
  expect(leaderRepl?.name).toBe('REPL')
  const teammate = createTeammateContext({
    agentId: 'w@t',
    agentName: 'w',
    teamName: 't',
    planModeRequired: false,
    parentSessionId: 'leader',
    abortController: new AbortController(),
  })
  expect(runWithTeammateContext(teammate, () => getREPLTool())).toBeNull()
  expect(getREPLTool()).toBe(leaderRepl)
})
