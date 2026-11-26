import { expect, test } from 'bun:test'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import { getIsInteractive, setIsInteractive } from '../../bootstrap/state.js'
import { resetCodeModeGateForTesting } from '../../tools/REPLTool/codeModeGate.js'
import { resetSettingsCache, setSessionSettingsCache } from '../../utils/settings/settingsCache.js'
import { unknownToolSuffix } from './toolExecution.js'

test('a built-in tool missing from the session says why like 2.1.311', () => {
  const context = getEmptyToolPermissionContext()
  expect(unknownToolSuffix('Bash', context)).toBe(
    '. Bash is not among the tools available here. Continue with the tools you have.',
  )
  const denied = {
    ...context,
    alwaysDenyRules: { ...context.alwaysDenyRules, userSettings: ['Bash'] },
  }
  expect(unknownToolSuffix('Bash', denied)).toBe(
    '. Bash is disabled for this session, in subagents as well as here.',
  )
})

test('a tool name the CLI does not know adds nothing', () => {
  expect(unknownToolSuffix('NoSuchThing', getEmptyToolPermissionContext())).toBe('')
})

test('Glob and Grep replaced by embedded search point at Bash like 2.1.311', () => {
  const context = getEmptyToolPermissionContext()
  expect(unknownToolSuffix('Glob', context, ['Bash'], true)).toBe(
    '. Glob is not available in this session — find files with `find` via the Bash tool instead.',
  )
  expect(unknownToolSuffix('Grep', context, ['Bash'], true)).toBe(
    '. Grep is not available in this session — search file contents with `grep` via the Bash tool instead.',
  )
  expect(unknownToolSuffix('Grep', context, [], true)).toBe('. Grep is disabled for this session.')
})

test('a built-in tool switched off for this build state says it is disabled', () => {
  expect(unknownToolSuffix('TaskCreate', getEmptyToolPermissionContext(), [], false)).toBe(
    '. TaskCreate is disabled for this session, in subagents as well as here.',
  )
})

test('a subagent calling Poll in Code Mode is told to finish with its own tools, as 2.1.325', () => {
  const saved = { mode: process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE, entry: process.env.CLAUDE_CODE_ENTRYPOINT }
  const interactive = getIsInteractive()
  process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  setIsInteractive(true)
  setSessionSettingsCache({ settings: {}, errors: [] })
  resetCodeModeGateForTesting()
  try {
    const context = getEmptyToolPermissionContext()
    expect(unknownToolSuffix('Poll', context, ['REPL'], false, true)).toBe(
      '. Poll is not available to this agent. Complete the task with the tools provided and return findings to the orchestrator.',
    )
    expect(unknownToolSuffix('Poll', context, ['REPL'], false, false)).not.toContain('this agent')
  } finally {
    for (const [key, value] of [['CLAUDE_CODE_EXPERIMENTAL_CODE_MODE', saved.mode], ['CLAUDE_CODE_ENTRYPOINT', saved.entry]] as const)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    setIsInteractive(interactive)
    resetSettingsCache()
    resetCodeModeGateForTesting()
  }
})

test('a coordinator calling a worker tool is pointed at a worker like 2.1.329', () => {
  const context = getEmptyToolPermissionContext()
  const coordinatorSuffix = '. Bash is not available to you as the coordinator \u2014 run it from a worker via the Agent tool instead.'
  expect(unknownToolSuffix('Bash', context, ['Agent'], false, false, true)).toBe(coordinatorSuffix)
  expect(unknownToolSuffix('Bash', context, [], false, false, true)).toBe(
    '. Bash is not among the tools available here. Continue with the tools you have.',
  )
  expect(unknownToolSuffix('Bash', context, ['Agent'], false, true, true)).not.toContain('coordinator')
  expect(unknownToolSuffix('Bash', context, ['Agent'], false, false, false)).not.toContain('coordinator')
  const denied = {
    ...context,
    alwaysDenyRules: { ...context.alwaysDenyRules, userSettings: ['Bash'] },
  }
  expect(unknownToolSuffix('Bash', denied, ['Agent'], false, false, true)).toBe(
    '. Bash is disabled for this session, in subagents as well as here.',
  )
  expect(unknownToolSuffix('SendMessage', context, ['Agent'], false, false, true)).not.toContain('coordinator')
  const saved = process.env.CLAUDE_CODE_SIMPLE
  process.env.CLAUDE_CODE_SIMPLE = '1'
  try {
    expect(unknownToolSuffix('Bash', context, ['Agent'], false, false, true)).not.toContain('coordinator')
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_SIMPLE
    else process.env.CLAUDE_CODE_SIMPLE = saved
  }
})
