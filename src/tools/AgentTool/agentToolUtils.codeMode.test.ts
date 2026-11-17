import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getIsInteractive, setIsInteractive } from '../../bootstrap/state.js'
import { ASYNC_AGENT_ALLOWED_TOOLS } from '../../constants/tools.js'
import { getEmptyToolPermissionContext, type Tool, type Tools } from '../../Tool.js'
import { createTeammateContext, runWithTeammateContext } from '../../utils/teammateContext.js'
import { resetCodeModeGateForTesting, settleCodeModeGate } from '../REPLTool/codeModeGate.js'
import { replCallableToolsFrom } from '../REPLTool/toolWrappers.js'
import { primitiveToolGrant, resolveAgentTools } from './agentToolUtils.js'

const envKeys = ['CLAUDE_CODE_EXPERIMENTAL_CODE_MODE', 'CLAUDE_CODE_ENTRYPOINT'] as const
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
const savedInteractive = getIsInteractive()

function tool(name: string): Tool {
  return { name, isEnabled: () => true } as unknown as Tool
}

// A Code Mode pool: Read, Bash, ... are gone; REPL and Poll stand in for them.
const codeModePool: Tools = [tool('REPL'), tool('Poll'), tool('Write'), tool('Edit'), tool('WebFetch')]

function codeModeOn(): void {
  process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  setIsInteractive(true)
  settleCodeModeGate({ remoteControl: false, remote: false })
}

function agent(tools?: string[], disallowedTools?: string[]) {
  return { tools, disallowedTools, source: 'userSettings' as const }
}

function names(tools: Tools): string[] {
  return tools.map(t => t.name)
}

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

test('background agents may use REPL and Poll', () => {
  expect(ASYNC_AGENT_ALLOWED_TOOLS.has('REPL')).toBe(true)
  expect(ASYNC_AGENT_ALLOWED_TOOLS.has('Poll')).toBe(true)
})

describe('resolveAgentTools in Code Mode', () => {
  test('a Code Mode only entry is valid and grants REPL and Poll once', () => {
    codeModeOn()
    const resolved = resolveAgentTools(agent(['Read', 'Bash', 'WebFetch']), codeModePool)
    expect(resolved.validTools).toEqual(['Read', 'Bash', 'WebFetch'])
    expect(resolved.invalidTools).toEqual([])
    expect(names(resolved.resolvedTools)).toEqual(['REPL', 'WebFetch', 'Poll'])
  })

  test('disallowedTools: [REPL] takes REPL away and the entries become invalid', () => {
    codeModeOn()
    const resolved = resolveAgentTools(agent(['Read', 'WebFetch'], ['REPL']), codeModePool)
    expect(resolved.invalidTools).toEqual(['Read'])
    expect(names(resolved.resolvedTools)).toEqual(['WebFetch'])
  })

  test('a subagent left without REPL loses Poll; the main thread keeps it', () => {
    codeModeOn()
    expect(names(resolveAgentTools(agent(undefined, ['REPL']), codeModePool).resolvedTools)).not.toContain('Poll')
    expect(names(resolveAgentTools(agent(undefined, ['REPL']), codeModePool, false, true).resolvedTools)).toContain('Poll')
  })

  test('with Code Mode off a Code Mode only entry stays invalid', () => {
    const resolved = resolveAgentTools(agent(['Read', 'WebFetch']), codeModePool)
    expect(resolved.invalidTools).toEqual(['Read'])
    expect(names(resolved.resolvedTools)).toEqual(['WebFetch'])
  })

  test('an in-process teammate does not get the Code Mode branch', async () => {
    codeModeOn()
    const context = createTeammateContext({
      agentId: 'w@t', agentName: 'w', teamName: 't', planModeRequired: false,
      parentSessionId: 'leader', abortController: new AbortController(),
    })
    const resolved = await runWithTeammateContext(context, async () =>
      resolveAgentTools(agent(['Read', 'WebFetch']), codeModePool))
    expect(resolved.invalidTools).toEqual(['Read'])
  })
})

describe('primitiveToolGrant', () => {
  test('no list or a wildcard grants every primitive', () => {
    expect([...primitiveToolGrant(agent())].sort()).toEqual(
      ['Bash', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'PowerShell', 'Read', 'Write'],
    )
    expect(primitiveToolGrant(agent(['*'])).size).toBe(8)
  })

  test('follows the tools list and disallowedTools', () => {
    expect([...primitiveToolGrant(agent(['Read', 'Grep', 'WebFetch']))].sort()).toEqual(['Grep', 'Read'])
    expect(primitiveToolGrant(agent(undefined, ['Bash', 'Write'])).has('Bash')).toBe(false)
  })

  test('narrows only the primitives a REPL script may call', () => {
    const callable = names(replCallableToolsFrom(
      [tool('REPL'), tool('WebFetch')],
      getEmptyToolPermissionContext(),
      new Set(['Read']),
    ))
    expect(callable).toEqual(['WebFetch', 'Read'])
  })
})
