import { afterEach, beforeEach, expect, test } from 'bun:test'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { Command } from '../../types/command.js'
import {
  resetSettingsCache,
  setCachedSettingsForSource,
} from '../../utils/settings/settingsCache.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= {
  VERSION: 'test',
} as MacroGlobals

const { getCommandAllowedTools } = await import(
  '../../utils/permissions/permissionsLoader.js'
)
const { processPromptSlashCommand } = await import(
  '../../utils/processUserInput/processSlashCommand.js'
)
const { getDefaultAppState } = await import('../../state/AppStateStore.js')

function useManagedRulesOnly(enabled: boolean): void {
  resetSettingsCache()
  setCachedSettingsForSource(
    'policySettings',
    enabled ? { allowManagedPermissionRulesOnly: true } : null,
  )
}

beforeEach(() => useManagedRulesOnly(true))
afterEach(() => resetSettingsCache())

const tools = ['Bash(git push:*)', 'Write']

test('repository, user, flag, MCP and third-party plugin skills cannot pre-approve tools under allowManagedPermissionRulesOnly', () => {
  for (const source of [
    'projectSettings',
    'localSettings',
    'userSettings',
    'flagSettings',
    'mcp',
  ] as const) {
    expect(getCommandAllowedTools({ source, allowedTools: tools })).toEqual([])
  }
  expect(
    getCommandAllowedTools({
      source: 'plugin',
      allowedTools: tools,
      pluginInfo: { repository: 'helper@some-marketplace' },
    }),
  ).toEqual([])
  expect(getCommandAllowedTools({ source: 'plugin', allowedTools: tools })).toEqual([])
})

test('managed, built-in, bundled and official marketplace skills keep allowed-tools under allowManagedPermissionRulesOnly', () => {
  for (const source of ['policySettings', 'builtin', 'bundled'] as const) {
    expect(getCommandAllowedTools({ source, allowedTools: tools })).toEqual(tools)
  }
  expect(
    getCommandAllowedTools({
      source: 'plugin',
      allowedTools: tools,
      pluginInfo: { repository: 'helper@claude-plugins-official' },
    }),
  ).toEqual(tools)
})

test('skills keep allowed-tools without allowManagedPermissionRulesOnly', () => {
  useManagedRulesOnly(false)
  expect(getCommandAllowedTools({ source: 'projectSettings', allowedTools: tools })).toEqual(tools)
  expect(getCommandAllowedTools({ source: 'projectSettings' })).toEqual([])
})

test('an inline project skill grants no command rules under allowManagedPermissionRulesOnly', async () => {
  const command = {
    type: 'prompt',
    name: 'repo-skill',
    description: 'repo skill',
    progressMessage: 'running',
    contentLength: 1,
    source: 'projectSettings',
    loadedFrom: 'skills',
    allowedTools: tools,
    getPromptForCommand: async () => [{ type: 'text', text: 'BODY' }],
  } as unknown as Command
  let state = {
    ...getDefaultAppState(),
    toolPermissionContext: getEmptyToolPermissionContext(),
  }
  const context = {
    options: {
      commands: [command],
      tools: [],
      isNonInteractiveSession: true,
      mainLoopModel: 'claude-sonnet-4-6',
      agentDefinitions: { activeAgents: [] },
    },
    messages: [],
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (fn: (prev: typeof state) => typeof state) => {
      state = fn(state)
    },
    setResponseLength: () => {},
  }

  const result = await processPromptSlashCommand(
    'repo-skill',
    '',
    [command],
    context as never,
  )

  expect(result.allowedTools ?? []).toEqual([])
})
