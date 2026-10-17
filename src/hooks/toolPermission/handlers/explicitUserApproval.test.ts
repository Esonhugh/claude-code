import { expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionDecision } from '../../../utils/permissions/PermissionResult.js'
import type { PermissionContext } from '../PermissionContext.js'

const childFlag = 'CLAUDE_CODE_EXPLICIT_APPROVAL_HANDLERS_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('explicit approval handlers (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-explicit-approval-'))
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EMBEDDED_)/.test(key),
      ),
    )
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=BASH_CLASSIFIER', '--timeout', '30000', import.meta.path], {
        cwd: join(import.meta.dir, '../../../..'),
        env: {
          ...env,
          [childFlag]: '1',
          HOME: home,
          CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_API_KEY: 'test-only-not-a-real-key',
          DISABLE_TELEMETRY: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      expect(code).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 180_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
    VERSION: 'test',
  }
  process.env.NODE_ENV = 'test'

  let asyncClassifierCalls = 0
  mock.module('../../../tools/BashTool/bashPermissions.js', () => ({
    MAX_SUBCOMMANDS_FOR_SECURITY_CHECK: 50,
    MAX_SUGGESTED_RULES_FOR_COMPOUND: 5,
    BINARY_HIJACK_VARS: /^(LD_|DYLD_|PATH$)/,
    bashPermissionRule: {},
    bashToolCheckExactMatchPermission: () => null,
    bashToolCheckPermission: () => null,
    bashToolHasPermission: () => Promise.resolve(null),
    checkCommandAndSuggestRules: () => Promise.resolve(null),
    getSimpleCommandPrefix: () => null,
    getFirstWordPrefix: () => null,
    permissionRuleExtractPrefix: () => null,
    matchWildcardPattern: () => false,
    stripSafeWrappers: (command: string) => command,
    stripWrappersFromArgv: (argv: string[]) => argv,
    stripAllLeadingEnvVars: (argv: string[]) => argv,
    executeAsyncClassifierCheck: () => {
      asyncClassifierCalls += 1
      return Promise.resolve()
    },
    awaitClassifierAutoApproval: () => Promise.resolve(null),
    peekSpeculativeClassifierCheck: () => undefined,
    consumeSpeculativeClassifierCheck: () => Promise.resolve(undefined),
    startSpeculativeClassifierCheck: () => {},
    clearSpeculativeChecks: () => {},
    commandHasAnyCd: () => false,
    isNormalizedGitCommand: () => false,
    isNormalizedCdCommand: () => false,
  }))

  let registeredWorkerCallback:
    | {
        onReject(feedback?: string): void
      }
    | undefined
  let forwardedWorkerRequests = 0
  mock.module('../../../utils/agentSwarmsEnabled.js', () => ({
    isAgentSwarmsEnabled: () => true,
  }))
  mock.module('../../../utils/swarm/permissionSync.js', () => ({
    createPermissionRequest: () => ({ id: 'request-id' }),
    isSwarmWorker: () => true,
    sendPermissionRequestViaMailbox: () => {
      forwardedWorkerRequests += 1
      return Promise.resolve(true)
    },
  }))
  mock.module('../../useSwarmPermissionPoller.js', () => ({
    registerPermissionCallback: (callback: {
      onReject(feedback?: string): void
    }) => {
      registeredWorkerCallback = callback
    },
    unregisterPermissionCallback: () => {},
    processMailboxPermissionResponse: () => false,
  }))

  const { handleCoordinatorPermission } =
    await import('./coordinatorHandler.js')
  const { handleInteractivePermission } =
    await import('./interactiveHandler.js')
  const { handleSwarmWorkerPermission } =
    await import('./swarmWorkerHandler.js')

  const explicitApprovalReason = {
    type: 'safetyCheck' as const,
    reason: 'Removal requires explicit approval',
    classifierApprovable: false,
  }
  const pendingClassifierCheck = {
    command: 'placeholder command',
    cwd: '/tmp',
    descriptions: ['placeholder'],
  }

  function createTestContext() {
    let hookCalls = 0
    let awaitedClassifierCalls = 0
    let queueItem:
      | {
          onAllow(input: Record<string, unknown>, updates: []): Promise<void>
          recheckPermission(): Promise<void>
        }
      | undefined
    const abortController = new AbortController()
    const ctx = {
      tool: {
        name: 'Bash',
        requiresUserInteraction: () => false,
      },
      input: { command: 'placeholder command' },
      toolUseID: 'tool-use-id',
      assistantMessage: {},
      toolUseContext: {
        abortController,
        options: { isNonInteractiveSession: false },
        getAppState: () => ({ mcp: { clients: [] } }),
        setAppState: () => {},
      },
      runHooks: async () => {
        hookCalls += 1
        return {
          behavior: 'allow' as const,
          updatedInput: { command: 'hook-approved' },
          userModified: false,
        }
      },
      tryClassifier: async () => {
        awaitedClassifierCalls += 1
        return {
          behavior: 'allow' as const,
          updatedInput: { command: 'classifier-approved' },
          userModified: false,
        }
      },
      pushToQueue: (item: typeof queueItem) => {
        queueItem = item
      },
      updateQueueItem: () => {},
      removeFromQueue: () => {},
      logDecision: () => {},
      logCancelled: () => {},
      buildAllow: (input: Record<string, unknown>) => ({
        behavior: 'allow' as const,
        updatedInput: input,
        userModified: false,
      }),
      handleUserAllow: async (input: Record<string, unknown>) => ({
        behavior: 'allow' as const,
        updatedInput: input,
        userModified: false,
      }),
      cancelAndAbort: (feedback?: string) => ({
        behavior: 'ask' as const,
        message: feedback ?? 'cancelled',
      }),
    } as unknown as PermissionContext

    return {
      ctx,
      getHookCalls: () => hookCalls,
      getAwaitedClassifierCalls: () => awaitedClassifierCalls,
      getQueueItem: () => queueItem,
    }
  }

  test('coordinator skips hooks and classifier for explicit approval', async () => {
    const testContext = createTestContext()
    const result = await handleCoordinatorPermission({
      ctx: testContext.ctx,
      pendingClassifierCheck,
      updatedInput: undefined,
      suggestions: undefined,
      permissionMode: 'bypassPermissions',
      requiresExplicitUserApproval: true,
    })

    expect(result).toBeNull()
    expect(testContext.getHookCalls()).toBe(0)
    expect(testContext.getAwaitedClassifierCalls()).toBe(0)
  })

  test('interactive flow waits for a human decision', async () => {
    const testContext = createTestContext()
    let resolved: PermissionDecision | undefined

    handleInteractivePermission(
      {
        ctx: testContext.ctx,
        description: 'placeholder',
        result: {
          behavior: 'ask',
          message: 'approval required',
          decisionReason: explicitApprovalReason,
          pendingClassifierCheck,
        },
        awaitAutomatedChecksBeforeDialog: false,
        requiresExplicitUserApproval: true,
      },
      decision => {
        resolved = decision
      },
    )
    await Promise.resolve()

    expect(testContext.getHookCalls()).toBe(0)
    expect(asyncClassifierCalls).toBe(0)
    expect(resolved).toBeUndefined()

    await testContext.getQueueItem()?.recheckPermission()
    expect(resolved).toBeUndefined()

    await testContext
      .getQueueItem()
      ?.onAllow({ command: 'manually approved' }, [])
    expect(resolved?.behavior).toBe('allow')
  })

  test('swarm worker forwards explicit approval to the leader', async () => {
    const testContext = createTestContext()
    const decisionPromise = handleSwarmWorkerPermission({
      ctx: testContext.ctx,
      description: 'placeholder',
      pendingClassifierCheck,
      updatedInput: undefined,
      suggestions: undefined,
      requiresExplicitUserApproval: true,
    })
    await Promise.resolve()

    expect(testContext.getAwaitedClassifierCalls()).toBe(0)
    expect(forwardedWorkerRequests).toBe(1)
    expect(registeredWorkerCallback).toBeDefined()

    registeredWorkerCallback?.onReject('leader rejected')
    expect((await decisionPromise)?.behavior).toBe('ask')
  })
}
