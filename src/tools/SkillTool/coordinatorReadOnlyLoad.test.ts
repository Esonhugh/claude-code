import { expect, test } from 'bun:test'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { Command } from '../../types/command.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= {
  VERSION: 'test',
} as MacroGlobals

const { processPromptSlashCommand } = await import(
  '../../utils/processUserInput/processSlashCommand.js'
)
const { executeShellCommandsInPrompt } = await import(
  '../../utils/promptShellExecution.js'
)
const { getDefaultAppState } = await import('../../state/AppStateStore.js')

function makeContext(command: Command, options: Record<string, unknown>) {
  let state = {
    ...getDefaultAppState(),
    toolPermissionContext: getEmptyToolPermissionContext(),
  }
  let stateUpdates = 0
  const context = {
    options: {
      commands: [command],
      tools: [],
      isNonInteractiveSession: true,
      mainLoopModel: 'claude-sonnet-4-6',
      agentDefinitions: { activeAgents: [] },
      ...options,
    },
    messages: [],
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (fn: (prev: typeof state) => typeof state) => {
      stateUpdates++
      state = fn(state)
    },
    setResponseLength: () => {},
  }
  return { context, updates: () => stateUpdates }
}

const command = {
  type: 'prompt',
  name: 'repo-skill',
  description: 'repo skill',
  progressMessage: 'running',
  contentLength: 1,
  source: 'userSettings',
  loadedFrom: 'skills',
  allowedTools: ['Bash(git push:*)'],
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }] },
  getPromptForCommand: async () => [{ type: 'text', text: 'SKILL BODY' }],
} as unknown as Command

test('a read-only skill load returns the instructions without grants or hooks', async () => {
  const { context, updates } = makeContext(command, {
    isSkillPreload: true,
    readOnlySkillLoad: true,
  })
  const result = await processPromptSlashCommand('repo-skill', '', [command], context as never)

  expect(JSON.stringify(result.messages)).toContain('SKILL BODY')
  expect(result.allowedTools).toEqual([])
  expect(updates()).toBe(0)
})

test('a normal skill load still grants allowed-tools and registers hooks', async () => {
  const { context, updates } = makeContext(command, {})
  const result = await processPromptSlashCommand('repo-skill', '', [command], context as never)

  expect(result.allowedTools).toEqual(['Bash(git push:*)'])
  expect(updates()).toBeGreaterThan(0)
})

test('a read-only skill load replaces prompt shell commands instead of running them', async () => {
  const placeholder =
    '[shell command not executed: read-only skill load on the coordinator — delegate to a worker to run it]'
  const text = 'before !`touch /nonexistent/x` mid\n```!\nrm -rf /nonexistent\n```\nafter'
  const out = await executeShellCommandsInPrompt(
    text,
    { options: { readOnlySkillLoad: true } } as never,
    'repo-skill',
  )
  expect(out).toBe(`before ${placeholder} mid\n${placeholder}\nafter`)
})
