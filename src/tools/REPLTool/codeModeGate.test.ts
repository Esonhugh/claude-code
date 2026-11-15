import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Tool } from '../../Tool.js'
import { getIsInteractive, getIsRemoteMode, setIsInteractive, setIsRemoteMode } from '../../bootstrap/state.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from '../../utils/teammate.js'
import {
  codeModeOnlyToolError,
  codeModeOnlyToolSuffix,
  codeModeRefusesDirectCall,
  codeModeUnavailableMessage,
  getCodeModeState,
  hideCodeModeOnlyTools,
  isCodeModeEnabled,
  resetCodeModeGateForTesting,
} from './codeModeGate.js'
import { CODE_MODE_ONLY_TOOLS, isReplModeEnabled, REPL_PRIMITIVE_TOOL_NAMES } from './constants.js'

const envKeys = [
  'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_REMOTE',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_BRIDGE_REATTACH_SESSION',
  'CLAUDE_CODE_REPL',
  'CLAUDE_REPL_MODE',
] as const
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
const savedArgv = process.argv
const savedInteractive = getIsInteractive()
const savedRemoteMode = getIsRemoteMode()

function turnOn(): void {
  process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  setIsInteractive(true)
}

function tool(name: string, extra: Partial<Tool> = {}): Tool {
  return { name, ...extra } as Tool
}

beforeEach(() => {
  for (const key of envKeys) delete process.env[key]
  process.argv = ['bun', 'claude']
  setIsInteractive(false)
  setIsRemoteMode(false)
  clearDynamicTeamContext()
  resetCodeModeGateForTesting()
})

afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  process.argv = savedArgv
  setIsInteractive(savedInteractive)
  setIsRemoteMode(savedRemoteMode)
  clearDynamicTeamContext()
  resetCodeModeGateForTesting()
})

describe('isCodeModeEnabled', () => {
  test('off with no reason when the variable is unset, and REPL mode stays off', () => {
    setIsInteractive(true)
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    expect(getCodeModeState()).toEqual({ enabled: false })
    expect(isReplModeEnabled()).toBe(false)
  })

  test('off with no reason for an explicit 0', () => {
    turnOn()
    process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '0'
    expect(getCodeModeState()).toEqual({ enabled: false })
  })

  test('on in the interactive CLI, and turns REPL mode on', () => {
    turnOn()
    expect(isCodeModeEnabled()).toBe(true)
    expect(isReplModeEnabled()).toBe(true)
  })

  test('CLAUDE_CODE_REPL=0 still turns REPL mode off', () => {
    turnOn()
    process.env.CLAUDE_CODE_REPL = '0'
    expect(isReplModeEnabled()).toBe(false)
  })

  test('memoizes the first decision', () => {
    turnOn()
    expect(isCodeModeEnabled()).toBe(true)
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE
    expect(isCodeModeEnabled()).toBe(true)
  })

  test('refuses a value other than 1 with bad_value', () => {
    turnOn()
    process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = 'maybe'
    expect(getCodeModeState()).toEqual({ enabled: false, reason: 'bad_value' })
  })

  test.each([
    ['non-cli entrypoint', () => { process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts' }],
    ['non-interactive session', () => setIsInteractive(false)],
    ['remote mode', () => setIsRemoteMode(true)],
    ['CLAUDE_CODE_REMOTE', () => { process.env.CLAUDE_CODE_REMOTE = '1' }],
    ['ANTHROPIC_UNIX_SOCKET', () => { process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/sock' }],
  ])('refuses a %s with entrypoint', (_label, arrange) => {
    turnOn()
    arrange()
    expect(getCodeModeState()).toEqual({ enabled: false, reason: 'entrypoint' })
  })

  test.each([
    ['teammate', () => setDynamicTeamContext({ agentId: 'a@t', agentName: 'a', teamName: 't', planModeRequired: false })],
    ['--rc flag', () => { process.argv = ['bun', 'claude', '--rc'] }],
    ['--remote-control=name flag', () => { process.argv = ['bun', 'claude', '--remote-control=box'] }],
    ['bridge reattach', () => { process.env.CLAUDE_BRIDGE_REATTACH_SESSION = 'sess' }],
  ])('refuses a %s with unattended', (_label, arrange) => {
    turnOn()
    arrange()
    expect(getCodeModeState()).toEqual({ enabled: false, reason: 'unattended' })
  })

  test('refusal text follows the official wording', () => {
    expect(codeModeUnavailableMessage('unattended')).toBe(
      "Code Mode (experimental) isn't available: for now it doesn't work in background jobs, in teammates' panes or with Remote Control. Starting with the ordinary tools.",
    )
    expect(codeModeUnavailableMessage('entrypoint')).toBe(
      "Code Mode (experimental) isn't available: for now it only works in the interactive terminal. Starting with the ordinary tools.",
    )
    expect(codeModeUnavailableMessage('bad_value')).toBe(
      "Code Mode (experimental) isn't available: CLAUDE_CODE_EXPERIMENTAL_CODE_MODE must be 1 to turn it on. Starting with the ordinary tools.",
    )
  })
})

describe('tool sets', () => {
  test('match the official Code Mode sets', () => {
    expect([...CODE_MODE_ONLY_TOOLS].sort()).toEqual(['Bash', 'Glob', 'Grep', 'NotebookEdit', 'PowerShell', 'Read'])
    expect([...REPL_PRIMITIVE_TOOL_NAMES].sort()).toEqual(
      ['Bash', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'PowerShell', 'Read', 'Write'],
    )
  })
})

describe('hiding', () => {
  const repl = tool('REPL')
  const pool = [
    repl,
    tool('Poll'),
    tool('StructuredOutput'),
    tool('Write'),
    tool('Edit'),
    tool('Agent'),
    tool('ToolSearch'),
    tool('mcp__srv__q', { isMcp: true }),
  ]

  test('sends only REPL, Poll and StructuredOutput when Code Mode is on', () => {
    turnOn()
    expect(hideCodeModeOnlyTools(pool).map(t => t.name)).toEqual(['REPL', 'Poll', 'StructuredOutput'])
  })

  test('changes nothing without a non-MCP REPL', () => {
    turnOn()
    const withoutRepl = pool.slice(1)
    expect(hideCodeModeOnlyTools(withoutRepl)).toBe(withoutRepl)
    const mcpRepl = [tool('REPL', { isMcp: true }), tool('Write')]
    expect(hideCodeModeOnlyTools(mcpRepl)).toBe(mcpRepl)
  })

  test('changes nothing when Code Mode is off', () => {
    expect(hideCodeModeOnlyTools(pool)).toBe(pool)
  })

  test('answers a direct call to a removed or hidden tool', () => {
    turnOn()
    const names = pool.map(t => t.name)
    expect(codeModeOnlyToolError('Write')).toBe('Write is only available inside REPL. Use REPL with code: await Write({...})')
    expect(codeModeOnlyToolSuffix('Read', names)).toBe('. Read is only available inside REPL. Use REPL with code: await Read({...})')
    expect(codeModeOnlyToolSuffix('Write', names)).toBe('. Write is only available inside REPL. Use REPL with code: await Write({...})')
    expect(codeModeOnlyToolSuffix('Nope', names)).toBe('')
    expect(codeModeOnlyToolSuffix('Poll', names)).toBe('')
    expect(codeModeOnlyToolSuffix('Read', names.filter(n => n !== 'REPL'))).toBe('')
  })

  test('refuses a model call to a hidden pool tool, but not script or Mods calls', () => {
    turnOn()
    const write = pool[3]!
    expect(codeModeRefusesDirectCall(write, pool, {})).toBe(true)
    expect(codeModeRefusesDirectCall(write, pool, { innerCall: true })).toBe(false)
    expect(codeModeRefusesDirectCall(write, pool, { modToolCallResult: () => {} })).toBe(false)
    expect(codeModeRefusesDirectCall(repl, pool, {})).toBe(false)
  })

  test('refuses nothing and adds no suffix when Code Mode is off', () => {
    expect(codeModeRefusesDirectCall(pool[3]!, pool, {})).toBe(false)
    expect(codeModeOnlyToolSuffix('Read', pool.map(t => t.name))).toBe('')
  })
})
