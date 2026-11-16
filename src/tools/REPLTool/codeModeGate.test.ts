import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext, type Tool } from '../../Tool.js'
import { getIsInteractive, getIsRemoteMode, setIsInteractive, setIsRemoteMode } from '../../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from '../../utils/teammate.js'
import { createTeammateContext, runWithTeammateContext } from '../../utils/teammateContext.js'
import {
  codeModeChromeUnavailableText,
  codeModeOnlyToolError,
  codeModeOnlyToolSuffix,
  codeModeRefusesDirectCall,
  codeModeRemoteControlNotConnectedText,
  codeModeRemoteControlRefusal,
  codeModeUnavailableMessage,
  getCodeModeState,
  hideCodeModeOnlyTools,
  isCodeModeEnabled,
  resetCodeModeGateForTesting,
  settleCodeModeGate,
  withoutCodeModeTools,
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
const savedRemoteControlAtStartup = getGlobalConfig().remoteControlAtStartup

function setRemoteControlAtStartup(value: boolean | undefined): void {
  saveGlobalConfig(current => ({ ...current, remoteControlAtStartup: value }))
}

function turnOn(): void {
  process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  setIsInteractive(true)
}

function teammateContext() {
  return createTeammateContext({
    agentId: 'w@t',
    agentName: 'w',
    teamName: 't',
    planModeRequired: false,
    parentSessionId: 'leader',
    abortController: new AbortController(),
  })
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
  setRemoteControlAtStartup(savedRemoteControlAtStartup)
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

  test('decides afresh until startup settles it', () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    expect(isCodeModeEnabled()).toBe(false)
    setIsInteractive(true)
    expect(isCodeModeEnabled()).toBe(true)
  })

  test('pins the decision once startup settles it', () => {
    turnOn()
    expect(settleCodeModeGate({ remoteControl: false, remote: false })).toEqual({ enabled: true })
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE
    expect(isCodeModeEnabled()).toBe(true)
  })

  test('the Remote Control ask and --remote refuse it at settle time', () => {
    turnOn()
    expect(settleCodeModeGate({ remoteControl: true, remote: false })).toEqual({ enabled: false, reason: 'unattended' })
    expect(settleCodeModeGate({ remoteControl: false, remote: true })).toEqual({ enabled: false, reason: 'entrypoint' })
  })

  // Official asks only about --rc and the reattach variable; the default
  // (toe) keeps Code Mode on and the bridge refuses itself (wun, repl_mode).
  test('the remoteControlAtStartup default is not a Remote Control ask', () => {
    turnOn()
    setRemoteControlAtStartup(true)
    expect(getCodeModeState()).toEqual({ enabled: true })
    expect(settleCodeModeGate({ remoteControl: false, remote: false })).toEqual({ enabled: true })
  })

  test('--rc and the reattach variable still refuse it with the default on', () => {
    turnOn()
    setRemoteControlAtStartup(true)
    expect(settleCodeModeGate({ remoteControl: true, remote: false })).toEqual({ enabled: false, reason: 'unattended' })
    resetCodeModeGateForTesting()
    process.env.CLAUDE_BRIDGE_REATTACH_SESSION = 'sess'
    expect(settleCodeModeGate({ remoteControl: false, remote: false })).toEqual({ enabled: false, reason: 'unattended' })
  })

  test('in-process teammates are refused per context while the leader keeps it', async () => {
    turnOn()
    settleCodeModeGate({ remoteControl: false, remote: false })
    const inTeammate = await runWithTeammateContext(teammateContext(), async () => {
      await Promise.resolve()
      return getCodeModeState()
    })
    expect(inTeammate).toEqual({ enabled: false, reason: 'unattended' })
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

  test('answers a direct call only for a tool Code Mode removed (official)', () => {
    turnOn()
    const names = pool.map(t => t.name)
    expect(codeModeOnlyToolError('Read')).toBe('Read is only available inside REPL. Use REPL with code: await Read({...}).')
    expect(codeModeOnlyToolSuffix('Read', names)).toBe('. Read is only available inside REPL. Use REPL with code: await Read({...}).')
    expect(codeModeOnlyToolSuffix('Bash', names)).toBe('. Bash is only available inside REPL. Use REPL with code: await Bash({...}).')
    expect(codeModeOnlyToolSuffix('Write', names)).toBe('')
    expect(codeModeOnlyToolSuffix('mcp__srv__q', names)).toBe('')
    expect(codeModeOnlyToolSuffix('Nope', names)).toBe('')
    expect(codeModeOnlyToolSuffix('Poll', names)).toBe('')
    expect(codeModeOnlyToolSuffix('Read', names.filter(n => n !== 'REPL'))).toBe('')
  })

  test('refuses a model call only to a Code Mode only tool; Write, Edit and MCP still run', () => {
    turnOn()
    const read = tool('Read')
    const withRead = [...pool, read]
    expect(codeModeRefusesDirectCall(read, withRead, {})).toBe(true)
    expect(codeModeRefusesDirectCall(read, withRead, { innerCall: true })).toBe(false)
    expect(codeModeRefusesDirectCall(read, withRead, { modToolCallResult: () => {} })).toBe(false)
    expect(codeModeRefusesDirectCall(pool[3]!, pool, {})).toBe(false)
    expect(codeModeRefusesDirectCall(pool[4]!, pool, {})).toBe(false)
    expect(codeModeRefusesDirectCall(pool[7]!, pool, {})).toBe(false)
    expect(codeModeRefusesDirectCall(repl, pool, {})).toBe(false)
  })

  test('refuses nothing and adds no suffix when Code Mode is off', () => {
    expect(codeModeRefusesDirectCall(tool('Read'), [...pool, tool('Read')], {})).toBe(false)
    expect(codeModeOnlyToolSuffix('Read', pool.map(t => t.name))).toBe('')
  })
})

describe('teammate pool', () => {
  const pool = [tool('REPL'), tool('Poll'), tool('Write'), tool('Edit'), tool('mcp__srv__q', { isMcp: true })]

  test('an in-process teammate gets the ordinary tools back', async () => {
    turnOn()
    settleCodeModeGate({ remoteControl: false, remote: false })
    expect(withoutCodeModeTools(pool, getEmptyToolPermissionContext())).toBe(pool)
    const names = await runWithTeammateContext(teammateContext(), async () =>
      withoutCodeModeTools(pool, getEmptyToolPermissionContext()).map(t => t.name))
    expect(names).not.toContain('REPL')
    expect(names).not.toContain('Poll')
    expect(names).toEqual(expect.arrayContaining(['Write', 'Edit', 'mcp__srv__q', 'Read', 'Bash']))
  })

  test('changes nothing when the process is not in Code Mode', async () => {
    const names = await runWithTeammateContext(teammateContext(), async () =>
      withoutCodeModeTools(pool, getEmptyToolPermissionContext()))
    expect(names).toBe(pool)
  })
})

test('the Chrome stand-in text follows the official wording', () => {
  expect(codeModeChromeUnavailableText()).toBe(
    'Claude in Chrome and computer use are not available while this session is in Code Mode (experimental), where the API does not yet add its safety rules for them. If the user asks for either, tell them why, and this: To use them, exit and start a new session with Code Mode off: CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=0 claude (add --chrome, if you started with it). This conversation can only be continued in Code Mode.',
  )
})

describe('Remote Control turned on mid-session', () => {
  test('is refused with the official text while Code Mode is on', () => {
    turnOn()
    settleCodeModeGate({ remoteControl: false, remote: false })
    expect(codeModeRemoteControlRefusal()).toBe(
      "Remote Control isn't available in Code Mode (experimental) yet. To use Remote Control, quit Claude Code and start it again with CLAUDE_CODE_EXPERIMENTAL_CODE_MODE set to 0.",
    )
  })

  test('is not refused when Code Mode is off or was refused at startup', () => {
    expect(codeModeRemoteControlRefusal()).toBeNull()
    turnOn()
    settleCodeModeGate({ remoteControl: true, remote: false })
    expect(codeModeRemoteControlRefusal()).toBeNull()
  })

  test('the startup notice text follows the official wording', () => {
    expect(codeModeRemoteControlNotConnectedText()).toBe(
      "Remote Control isn't available in Code Mode (experimental) yet, so this session isn't connected. To use Remote Control, quit Claude Code and start it again with CLAUDE_CODE_EXPERIMENTAL_CODE_MODE set to 0.",
    )
  })

  test('the leader still refuses it from an in-process teammate context', async () => {
    turnOn()
    settleCodeModeGate({ remoteControl: false, remote: false })
    await runWithTeammateContext(teammateContext(), async () => {
      expect(codeModeRemoteControlRefusal()).not.toBeNull()
    })
  })
})
