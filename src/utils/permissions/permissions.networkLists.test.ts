import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childKey = 'PERMISSIONS_NETWORK_LISTS_TEST_CHILD'

// Auto mode is compiled behind TRANSCRIPT_CLASSIFIER, and the classifier is
// mocked: run in a child with the feature on.
if (!process.env[childKey]) {
  test('allowed_domains in auto mode (TRANSCRIPT_CLASSIFIER child)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-network-lists-'))
    try {
      const child = Bun.spawn(
        [process.execPath, 'test', '--feature=TRANSCRIPT_CLASSIFIER', import.meta.path],
        {
          cwd: join(import.meta.dir, '../../..'),
          env: {
            PATH: process.env.PATH,
            HOME: root,
            CLAUDE_CONFIG_DIR: join(root, 'config'),
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            [childKey]: '1',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
} else {
  const { mock } = await import('bun:test')
  const { z } = await import('zod/v4')
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= {
    VERSION: 'test',
  } as MacroGlobals

  // Loaded first: yoloClassifier and permissions import each other.
  const { applyPermissionModeToResult } = await import('./permissions.js')
  let classified = 0
  const yolo = await import('./yoloClassifier.js')
  mock.module('./yoloClassifier.js', () => ({
    ...yolo,
    classifyYoloAction: async () => {
      classified++
      return { shouldBlock: false, reason: 'reviewed', model: 'test' }
    },
  }))

  const { setCachedSettingsForSource, setSessionSettingsCache } = await import(
    '../settings/settingsCache.js'
  )
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { takeCommandNetworkLists } = await import(
    '../sandbox/commandNetworkLists.js'
  )
  type Tool = import('../../Tool.js').Tool
  type ToolUseContext = import('../../Tool.js').ToolUseContext
  type PermissionDecision = import('./PermissionResult.js').PermissionDecision

  setSessionSettingsCache({ settings: { sandbox: { enabled: true } }, errors: [] })
  setCachedSettingsForSource('userSettings', { sandbox: { enabled: true } })

  const tool = (name: string) =>
    ({
      name,
      inputSchema: z.object({}).passthrough(),
      checkPermissions: async () => ({ behavior: 'passthrough', message: 'ask' }),
    }) as unknown as Tool
  const context = (mode: string) => {
    const initial = getDefaultAppState()
    const state = {
      ...initial,
      toolPermissionContext: { ...initial.toolPermissionContext, mode },
    }
    return {
      getAppState: () => state,
      setAppState: () => {},
      abortController: new AbortController(),
      messages: [],
      options: { isNonInteractiveSession: false, tools: [] },
    } as unknown as ToolUseContext
  }
  const input = { command: 'curl https://a.example', allowed_domains: ['a.example'] }
  const ruleAllow: PermissionDecision = {
    behavior: 'allow',
    updatedInput: input,
    decisionReason: { type: 'mode', mode: 'default' },
  }
  const decide = (name: string, mode: string, id: string) =>
    applyPermissionModeToResult(
      ruleAllow,
      tool(name),
      input,
      context(mode),
      { message: { id: 'msg_test' } } as never,
      id,
    )

  test('auto mode sends an allowed command with allowed_domains to the classifier', async () => {
    const decision = await decide('Bash', 'auto', 'toolu_auto')
    expect(classified).toBe(1)
    expect(decision.behavior).toBe('allow')
    expect(decision.decisionReason?.type).toBe('classifier')
    expect(takeCommandNetworkLists('toolu_auto', input.command)).toEqual({
      allowedDomains: ['a.example'],
    })
    // Once only.
    expect(takeCommandNetworkLists('toolu_auto', input.command)).toBeUndefined()
  })

  test('outside auto mode the list is ignored', async () => {
    classified = 0
    expect(await decide('Bash', 'default', 'toolu_default')).toBe(ruleAllow)
    expect(classified).toBe(0)
    expect(takeCommandNetworkLists('toolu_default', input.command)).toBeUndefined()
  })

  test('another tool with an allowed_domains field is not affected', async () => {
    classified = 0
    expect(await decide('WebSearch', 'auto', 'toolu_web')).toBe(ruleAllow)
    expect(classified).toBe(0)
  })

  test('approved lists apply only to the reviewed command', async () => {
    await decide('Monitor', 'auto', 'toolu_monitor')
    expect(takeCommandNetworkLists('toolu_monitor', 'curl https://b.example')).toBeUndefined()
  })
}
