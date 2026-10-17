import { expect, test } from 'bun:test'
import type { ToolUseContext } from '../Tool.js'
import { getEmptyToolPermissionContext } from '../Tool.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { createStore } from '../state/store.js'
import { registerAsyncAgent } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { GENERAL_PURPOSE_AGENT } from '../tools/AgentTool/built-in/generalPurposeAgent.js'
import { runAsyncAgentLifecycle } from '../tools/AgentTool/agentToolUtils.js'
import { createSubagentContext } from './forkedAgent.js'
import { createFileStateCacheWithSizeLimit } from './fileStateCache.js'
import { createAssistantMessage } from './messages.js'
import { AbortError } from './errors.js'
import { assertSubagentCapacity, takeSubagentConcurrencySlot } from './subagentConcurrency.js'

function setup() {
  const state = getDefaultAppState()
  const store = createStore({ ...state, toolPermissionContext: getEmptyToolPermissionContext() })
  const context = {
    options: { tools: [], mainLoopModel: 'claude-sonnet-4-6', subagentDepth: 0 },
    getAppState: store.getState, setAppState: store.setState, messages: [],
    abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
  } as unknown as ToolUseContext
  return { store, context }
}

test('nested async contexts retain a live root reader and writer despite overridden views', () => {
  const { store, context } = setup()
  const stale = store.getState()
  const child = createSubagentContext(context, { getAppState: () => stale })
  const grandchild = createSubagentContext(child)
  expect(child.getAppState()).toBe(stale)
  const release = takeSubagentConcurrencySlot(grandchild)
  expect(store.getState().runningSubagents).toBe(1)
  expect(grandchild.getAppStateForTasks?.().runningSubagents).toBe(1)
  release(); release()
  expect(store.getState().runningSubagents).toBe(0)
})

test('release clamps at zero and does not publish a redundant state update', () => {
  const { store, context } = setup()
  const release = takeSubagentConcurrencySlot(context)
  store.setState(prev => ({ ...prev, runningSubagents: 0 }))
  const zero = store.getState()
  release(); release()
  expect(store.getState()).toBe(zero)
})

for (const failure of [undefined, new Error('controlled lifecycle failure'), new AbortError('controlled abort')]) {
  test('slot settles before terminal status and blocked cleanup: ' + (failure?.name ?? 'success'), async () => {
    const { store, context } = setup()
    const taskId = 'slot-order-' + (failure?.name ?? 'success')
    registerAsyncAgent({ agentId: taskId, description: 'slot ordering', prompt: 'finish', selectedAgent: GENERAL_PURPOSE_AGENT, setAppState: store.setState, spawnDepth: 1 })
    const release = takeSubagentConcurrencySlot(context)
    const cleanupStarted = Promise.withResolvers<void>()
    const finishCleanup = Promise.withResolvers<void>()
    const countersAtTerminal: number[] = []
    const unsubscribe = store.subscribe(() => {
      if (store.getState().tasks[taskId]?.status !== 'running') countersAtTerminal.push(store.getState().runningSubagents)
    })
    const lifecycle = runAsyncAgentLifecycle({
      taskId, abortController: new AbortController(),
      async *makeStream() {
        if (failure) throw failure
        yield createAssistantMessage({ content: 'finished' })
      },
      metadata: { prompt: 'finish', resolvedAgentModel: 'claude-sonnet-4-6', isBuiltInAgent: true, startTime: Date.now(), agentType: 'general-purpose', isAsync: true },
      description: 'slot ordering', toolUseContext: context, rootSetAppState: store.setState,
      agentIdForCleanup: taskId, enableSummarization: false, onRunSettled: release,
      async getWorktreeResult() { cleanupStarted.resolve(); await finishCleanup.promise; return {} },
    })
    try {
      await cleanupStarted.promise
      expect(store.getState().tasks[taskId]?.status).toBe(failure instanceof AbortError ? 'killed' : failure ? 'failed' : 'completed')
      expect(countersAtTerminal[0]).toBe(0)
      expect(store.getState().runningSubagents).toBe(0)
      const replacementRelease = takeSubagentConcurrencySlot(context)
      finishCleanup.resolve()
      await lifecycle
      expect(store.getState().runningSubagents).toBe(1)
      replacementRelease()
      expect(store.getState().runningSubagents).toBe(0)
    } finally { finishCleanup.resolve(); await lifecycle; unsubscribe() }
  })
}

test('ultracode bypass requires an available Workflow runtime and a supported main model', () => {
  const { store, context } = setup()
  const originalLimit = process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS
  const originalFeatures = process.env.CLAUDE_CODE_RECOVER_FEATURES
  try {
    process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '1'
    process.env.CLAUDE_CODE_RECOVER_FEATURES = 'WORKFLOW_SCRIPTS'
    store.setState(prev => ({ ...prev, runningSubagents: 1, effortValue: 'ultracode', settings: { ...prev.settings, enableWorkflows: true } }))
    expect(() => assertSubagentCapacity(context)).toThrow('Concurrent subagent limit reached')
    context.options.mainLoopModel = 'claude-opus-4-7'
    expect(() => assertSubagentCapacity(context)).not.toThrow()
    store.setState(prev => ({ ...prev, settings: { ...prev.settings, enableWorkflows: false } }))
    expect(() => assertSubagentCapacity(context)).toThrow('Concurrent subagent limit reached')
    store.setState(prev => ({ ...prev, settings: { ...prev.settings, enableWorkflows: true } }))
    delete process.env.CLAUDE_CODE_RECOVER_FEATURES
    expect(() => assertSubagentCapacity(context)).toThrow('Concurrent subagent limit reached')
  } finally {
    if (originalLimit === undefined) delete process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS; else process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = originalLimit
    if (originalFeatures === undefined) delete process.env.CLAUDE_CODE_RECOVER_FEATURES; else process.env.CLAUDE_CODE_RECOVER_FEATURES = originalFeatures
  }
})
