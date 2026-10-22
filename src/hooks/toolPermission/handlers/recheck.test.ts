import { afterAll, expect, spyOn, test } from 'bun:test'
import type { PermissionDecision } from '../../../utils/permissions/PermissionResult.js'
import type { PermissionContext } from '../PermissionContext.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const permissions = await import('../../../utils/permissions/permissions.js')
const { handleInteractivePermission } = await import('./interactiveHandler.js')

let fresh: PermissionDecision = { behavior: 'ask', message: 'ask' }
const check = spyOn(permissions, 'hasPermissionsToUseTool').mockImplementation(async () => fresh)
afterAll(() => check.mockRestore())

function openDialog() {
  let resolved: PermissionDecision | undefined
  let item: { recheckPermission(): Promise<void> } | undefined
  const ctx = {
    tool: { name: 'Write', requiresUserInteraction: () => false },
    input: { file_path: 'a.ts' },
    toolUseID: 'toolu_recheck',
    assistantMessage: {},
    toolUseContext: {
      abortController: new AbortController(),
      options: { isNonInteractiveSession: false },
      getAppState: () => ({ mcp: { clients: [] } }),
      setAppState: () => {},
    },
    runHooks: async () => null,
    tryClassifier: async () => null,
    pushToQueue: (queued: typeof item) => { item = queued },
    updateQueueItem: () => {},
    removeFromQueue: () => {},
    logDecision: () => {},
    logCancelled: () => {},
    buildAllow: (input: Record<string, unknown>) => ({ behavior: 'allow' as const, updatedInput: input }),
    cancelAndAbort: () => ({ behavior: 'ask' as const, message: 'cancelled' }),
  } as unknown as PermissionContext
  handleInteractivePermission(
    {
      ctx,
      description: 'Write a.ts',
      result: { behavior: 'ask', message: 'Write needs approval' },
      awaitAutomatedChecksBeforeDialog: true,
      requiresExplicitUserApproval: false,
    },
    decision => { resolved = decision },
  )
  return {
    async recheck(decision: PermissionDecision) {
      fresh = decision
      await item!.recheckPermission()
    },
    resolved: () => resolved,
  }
}

const allow = (decisionReason: Extract<PermissionDecision, { behavior: 'allow' }>['decisionReason']) =>
  ({ behavior: 'allow', updatedInput: { file_path: 'a.ts' }, decisionReason }) as PermissionDecision

test('a queued dialog closes when a rule or a non-auto mode now allows it', async () => {
  const byRule = openDialog()
  await byRule.recheck(allow({
    type: 'rule',
    rule: { source: 'session', ruleBehavior: 'allow', ruleValue: { toolName: 'Write' } },
  }))
  expect(byRule.resolved()?.behavior).toBe('allow')

  const byMode = openDialog()
  await byMode.recheck(allow({ type: 'mode', mode: 'acceptEdits' }))
  expect(byMode.resolved()?.behavior).toBe('allow')
})

test('a queued dialog stays open when only auto mode would allow it', async () => {
  const byClassifier = openDialog()
  await byClassifier.recheck(allow({ type: 'classifier', classifier: 'auto-mode', reason: 'looks fine' }))
  expect(byClassifier.resolved()).toBeUndefined()

  const byAutoFastPath = openDialog()
  await byAutoFastPath.recheck(allow({ type: 'mode', mode: 'auto' }))
  expect(byAutoFastPath.resolved()).toBeUndefined()
})
