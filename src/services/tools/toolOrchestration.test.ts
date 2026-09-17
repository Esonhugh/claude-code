import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { createAssistantMessage } from '../../utils/messages.js'
import {
  getSessionSettingsCache,
  setSessionSettingsCache,
  resetSettingsCache,
  setCachedSettingsForSource,
} from '../../utils/settings/settingsCache.js'
import { runTools } from './toolOrchestration.js'
import { StreamingToolExecutor } from './StreamingToolExecutor.js'
import { createModsRuntime } from '../mods/runtime.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSubagentContext } from '../../utils/forkedAgent.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'

const originalSettings = getSessionSettingsCache()
setSessionSettingsCache({ settings: {}, errors: [] })
for (const source of [
  'userSettings',
  'projectSettings',
  'localSettings',
  'policySettings',
  'flagSettings',
] as const)
  setCachedSettingsForSource(source, {})
afterAll(() => {
  resetSettingsCache()
  if (originalSettings) setSessionSettingsCache(originalSettings)
})

function fixture(hooks: boolean | undefined) {
  const started: string[] = []
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  let captures = 0
  let releases = 0
  let classifications = 0
  const tool = {
    name: 'SchedulerFixture',
    inputSchema: z.object({ value: z.string() }),
    maxResultSizeChars: Infinity,
    isConcurrencySafe: () => {
      classifications++
      return true
    },
    call: async (input: { value: string }) => {
      const index = Number(input.value)
      started.push(input.value)
      entered[index]!.resolve()
      await gates[index]!.promise
      return { data: input }
    },
    mapToolResultToToolResultBlockParam: (
      input: { value: string },
      id: string,
    ) => ({ type: 'tool_result', tool_use_id: id, content: input.value }),
  } as unknown as Tool
  const mods =
    hooks === undefined
      ? undefined
      : {
          capture: () => {
            captures++
            const pinned = hooks
            return {
              release: () => {
                releases++
              },
              hasHooks: () => pinned,
              dispatch: async (
                _event: string,
                input: Record<string, unknown>,
                core: (input: Record<string, unknown>) => Promise<unknown>,
              ) => core(input),
            }
          },
        }
  const context = {
    options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true },
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
      sessionHooks: new Map(),
    }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    mods,
  } as unknown as ToolUseContext
  const blocks = [0, 1].map(index => ({
    type: 'tool_use' as const,
    caller: { type: 'direct' as const },
    id: `scheduler-${index}`,
    name: tool.name,
    input: { value: String(index) },
  }))
  const assistant = createAssistantMessage({ content: blocks })
  return {
    context,
    tool,
    blocks,
    assistant,
    gates,
    entered,
    started,
    captures: () => captures,
    releases: () => releases,
    classifications: () => classifications,
    changeHooks: (value: boolean) => {
      hooks = value
    },
  }
}
const allow = async () => ({ behavior: 'allow' as const })

describe('Mods scheduler admission', () => {
  for (const streaming of [false, true]) {
    test(`${streaming ? 'streaming' : 'batch'} pins before classification and serializes pinned tool.call hooks`, async () => {
      const f = fixture(true)
      const executor = streaming
        ? new StreamingToolExecutor([f.tool], allow, f.context)
        : undefined
      if (executor)
        for (const block of f.blocks) executor.addTool(block, f.assistant)
      const results = Array.fromAsync(
        executor
          ? executor.getRemainingResults()
          : runTools(f.blocks, [f.assistant], allow, f.context),
      )
      await f.entered[0]!.promise
      expect(f.captures()).toBe(1)
      expect(f.classifications()).toBe(0)
      expect(f.started).toEqual(['0'])
      expect(f.releases()).toBe(0)
      f.changeHooks(false)
      f.gates[0]!.resolve()
      await f.entered[1]!.promise
      expect(f.releases()).toBe(0)
      f.gates[1]!.resolve()
      await results
      expect(f.releases()).toBe(1)
    })

    test(`${streaming ? 'streaming' : 'batch'} author tool.list sees the executing context catalog`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'mods-scheduler-catalog-'))
      const diagnostics: unknown[] = []
      const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
      const f = fixture(true)
      f.context.mods = runtime
      f.context.options.agentDefinitions = { activeAgents: [], allAgents: [] }
      f.context.options.mainLoopModel = 'claude-sonnet-4-6'
      f.tool.prompt = async () => 'Scheduler tool description'
      try {
        const entry = join(root, 'register.ts')
        await writeFile(entry, `export function register(on) {
          on('tool.call', async ($) => ({result:{value:JSON.stringify(await $.tool.list())}}));
        }`)
        await runtime.reconcile([{name:'catalog',storageId:'catalog@test',pluginRoot:root,entrypoints:[entry]}])
        const executor = streaming ? new StreamingToolExecutor([f.tool], allow, f.context) : undefined
        if (executor) executor.addTool(f.blocks[0]!, f.assistant)
        // A failed hook would otherwise enter the real core and wait on this gate.
        f.gates[0]!.resolve()
        const updates = await Array.fromAsync(executor
          ? executor.getRemainingResults()
          : runTools([f.blocks[0]!], [f.assistant], allow, f.context))
        const result = updates.flatMap(update => {
          if (update.message?.type !== 'user') return []
          const content = update.message.message.content
          return typeof content === 'string' ? [] : content
        }).find(block => block.type === 'tool_result')
        expect(result).toMatchObject({content:JSON.stringify([{name:f.tool.name,description:'Scheduler tool description',mcp:false}])})
        expect(f.started).toEqual([])
        expect(diagnostics).toEqual([])
      } finally {
        await runtime.dispose()
        await rm(root, {recursive:true,force:true})
      }
    })

    test(`${streaming ? 'streaming' : 'batch'} retains actual queued Worker activation through reload`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'mods-scheduler-reload-'))
      const runtime = createModsRuntime()
      const f = fixture(true)
      f.context.mods = runtime
      try {
        const entry = join(root, 'register.ts')
        const plugin = {
          name: 'scheduler',
          storageId: 'scheduler',
          pluginRoot: root,
          entrypoints: [entry],
        }
        await writeFile(
          entry,
          `export function register(on) { on('tool.call', async ($, e, next) => { const r = await next(e); return { result: { value: 'old:' + r.result.value } }; }); }`,
        )
        await runtime.reconcile([plugin])
        const executor = streaming
          ? new StreamingToolExecutor([f.tool], allow, f.context)
          : undefined
        if (executor)
          for (const block of f.blocks) executor.addTool(block, f.assistant)
        const results = Array.fromAsync(
          executor
            ? executor.getRemainingResults()
            : runTools(f.blocks, [f.assistant], allow, f.context),
        )
        await f.entered[0]!.promise
        await writeFile(
          entry,
          `export function register(on) { on('tool.call', () => ({ result: { value: 'new' } })); }`,
        )
        await runtime.reconcile([plugin])
        f.gates[0]!.resolve()
        await f.entered[1]!.promise
        f.gates[1]!.resolve()
        const updates = await results
        expect(JSON.stringify(updates.map(update => update.message))).toContain(
          'old:0',
        )
        expect(JSON.stringify(updates.map(update => update.message))).toContain(
          'old:1',
        )
        const next = await Array.fromAsync(
          runTools([f.blocks[0]!], [f.assistant], allow, f.context),
        )
        expect(JSON.stringify(next.map(update => update.message))).toContain(
          'new',
        )
      } finally {
        for (const gate of f.gates) gate.resolve()
        await runtime.dispose()
        await rm(root, { recursive: true, force: true })
      }
    })

    test(`${streaming ? 'streaming' : 'batch'} cancellation skips queued effects and releases the pinned snapshot`, async () => {
      const f = fixture(true)
      const executor = streaming ? new StreamingToolExecutor([f.tool], allow, f.context) : undefined
      if (executor) for (const block of f.blocks) executor.addTool(block, f.assistant)
      const results = Array.fromAsync(executor
        ? executor.getRemainingResults()
        : runTools(f.blocks, [f.assistant], allow, f.context))
      try {
        await f.entered[0]!.promise
        f.context.abortController.abort()
        f.gates[0]!.resolve()
        await results
        expect(f.started).toEqual(['0'])
        expect(f.captures()).toBe(1)
        expect(f.releases()).toBe(1)
      } finally {
        for (const gate of f.gates) gate.resolve()
      }
    })

    test(`${streaming ? 'streaming' : 'batch'} keeps original concurrency with no Mods`, async () => {
      const f = fixture(undefined)
      const executor = streaming
        ? new StreamingToolExecutor([f.tool], allow, f.context)
        : undefined
      if (executor)
        for (const block of f.blocks) executor.addTool(block, f.assistant)
      const results = Array.fromAsync(
        executor
          ? executor.getRemainingResults()
          : runTools(f.blocks, [f.assistant], allow, f.context),
      )
      await Promise.all(f.entered.map(item => item.promise))
      expect(f.started).toEqual(['0', '1'])
      expect(f.captures()).toBe(0)
      for (const gate of f.gates) gate.resolve()
      await results
      expect(f.releases()).toBe(0)
    })
  }

  test('an initially empty snapshot stays pinned when tool.call hooks are enabled mid-batch', async () => {
    const f = fixture(false)
    const executor = new StreamingToolExecutor([f.tool], allow, f.context)
    executor.addTool(f.blocks[0]!, f.assistant)
    await f.entered[0]!.promise
    f.changeHooks(true)
    executor.addTool(f.blocks[1]!, f.assistant)
    await f.entered[1]!.promise
    expect(f.captures()).toBe(1)
    expect(f.classifications()).toBe(2)
    for (const gate of f.gates) gate.resolve()
    const updates = await Array.fromAsync(executor.getRemainingResults())
    expect(updates.every(update => !update.newContext?.modsSnapshot)).toBe(true)
    expect(f.releases()).toBe(1)
  })

  test('nested Agent/Workflow-like execution uses independent admission without a global lock', async () => {
    const f = fixture(true)
    f.tool.call = async (input, context) => {
      if (input.value === '0') {
        const nested = new StreamingToolExecutor([f.tool], allow, context)
        nested.addTool(f.blocks[1]!, f.assistant)
        await Array.fromAsync(nested.getRemainingResults())
      }
      return { data: input }
    }
    await Array.fromAsync(
      runTools([f.blocks[0]!], [f.assistant], allow, f.context),
    )
    expect(f.captures()).toBe(2)
    expect(f.releases()).toBe(2)
  })

  test('real subagent context shares runtime but not a parent batch snapshot or abort ownership', async () => {
    const f = fixture(true)
    f.context.readFileState = createFileStateCacheWithSizeLimit(10)
    f.context.modsSnapshot = f.context.mods!.capture()
    const child = createSubagentContext(f.context)
    expect(child.mods).toBe(f.context.mods)
    expect(child.modsSnapshot).toBeUndefined()
    expect(child.abortController).not.toBe(f.context.abortController)
    expect(child.getAppState).not.toBe(f.context.getAppState)
    f.tool.call = async input => ({ data: input })
    try {
      await Array.fromAsync(runTools([f.blocks[0]!], [f.assistant], allow, child))
      expect(f.captures()).toBe(2)
      expect(f.releases()).toBe(1)
      f.context.abortController.abort()
      expect(child.abortController.signal.aborted).toBe(true)
    } finally {
      f.context.modsSnapshot.release()
    }
    expect(f.releases()).toBe(2)
  })

  test('discard does not release an executing streaming call until it truly finishes', async () => {
    const f = fixture(true)
    const executor = new StreamingToolExecutor([f.tool], allow, f.context)
    executor.addTool(f.blocks[0]!, f.assistant)
    await f.entered[0]!.promise
    executor.discard()
    expect(f.releases()).toBe(0)
    f.gates[0]!.resolve()
    await Array.fromAsync(executor.getRemainingResults())
    expect(f.releases()).toBe(1)
  })
})
