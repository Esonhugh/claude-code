import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod/v4'
import { runInNewContext } from 'node:vm'
import type { Tool, ToolUseContext } from '../../Tool.js'
import {
  createAssistantMessage,
  createUserMessage,
  normalizeAttachmentForAPI,
} from '../../utils/messages.js'
import { dispatchModEvent } from './dispatch.js'
import type { ModDispatchHook } from './types.js'
import { runModToolCall } from './toolAdapter.js'
import { createModsRuntime } from './runtime.js'
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { getProjectDir } from '../../utils/sessionStorage.js'
import { getToolResultsDir } from '../../utils/toolResultStorage.js'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const assistant = createAssistantMessage({ content: 'test' })
const tool = {
  name: 'Fixture',
  outputSchema: z.object({ value: z.string() }),
  maxResultSizeChars: Infinity,
  mapToolResultToToolResultBlockParam: (
    result: { value: string },
    id: string,
  ) => ({
    type: 'tool_result',
    tool_use_id: id,
    content: result.value,
  }),
} as unknown as Tool
const context = {
  abortController: new AbortController(),
  agentId: 'agent-test',
} as ToolUseContext

function snapshot(...handlers: ModDispatchHook['invoke'][]) {
  return {
    hasHooks: () => true,
    release: () => {},
    dispatch: (
      event: string,
      input: Record<string, unknown>,
      core: (input: Record<string, unknown>) => Promise<unknown>,
      options?: {
        signal?: AbortSignal
        validateResult?: (
          value: unknown,
          nextResults: readonly unknown[],
        ) => void
      },
    ) =>
      dispatchModEvent({
        event,
        input,
        core,
        ...options,
        hooks: handlers.map((invoke, index) => ({
          plugin: `test-${index}`,
          tier: 'user',
          registration: { id: index + 1, event, hasCatch: false },
          invoke,
        })),
      }),
  }
}
function resultMessage(value: unknown, isError = false) {
  return {
    message: createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: isError ? 'permission denied' : 'original mapped output',
          is_error: isError,
        },
      ],
      toolUseResult: value,
      sourceToolAssistantUUID: assistant.uuid,
    }),
  }
}

describe('reviewed tool.call context persistence', () => {
  let root: string
  let configDir: string | undefined
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mods-context-persistence-'))
    configDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    getProjectDir.cache.clear?.()
  })
  afterEach(async () => {
    if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = configDir
    getProjectDir.cache.clear?.()
    await rm(root, { recursive: true, force: true })
  })
  async function files() {
    try { return await readdir(getToolResultsDir()) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  function attachmentContexts(messages: Awaited<ReturnType<typeof runModToolCall>>) {
    return messages.flatMap(({ message }) =>
      message.type === 'attachment' && message.attachment.type === 'hook_additional_context'
        ? message.attachment.content : [],
    )
  }
  function run(added: string[], options: Partial<Parameters<typeof runModToolCall>[0]> = {}) {
    return runModToolCall({
      snapshot: snapshot(async () => ({ result: { value: 'synthetic' }, context: added })),
      tool, toolUseID: 'call-1', input: {}, toolUseContext: context, assistantMessage: assistant,
      core: async () => { throw new Error('core must not run') },
      ...options,
    })
  }

  test.each([199999, 200000, 200001])('applies the %s aggregate context boundary without ordinary tool caps', async total => {
    const added = ['a'.repeat(100000), 'b'.repeat(total > 200000 ? 100000 : total - 100000), ...(total > 200000 ? ['c'] : [])]
    const delivered = attachmentContexts(await run(added, {
      tool: { ...tool, maxResultSizeChars: 50000 },
    }))
    const saved = await files()
    if (total <= 200000) {
      expect(delivered).toEqual(added)
      expect(saved).toEqual([])
    } else {
      expect(delivered).toHaveLength(1)
      expect(delivered[0]!.length).toBeLessThan(3000)
      expect(saved).toHaveLength(1)
      expect(JSON.parse(await readFile(join(getToolResultsDir(), saved[0]!), 'utf8'))).toEqual(added)
    }
  })

  test('keeps duplicates and uses reviewed content identity across repeated unsafe call IDs', async () => {
    const added = ['x'.repeat(100001)]
    const options = { toolUseID: '../../outside' }
    const first = attachmentContexts(await run(added, options))
    expect(attachmentContexts(await run(added, options))).toEqual(first)
    expect(await files()).toHaveLength(1)
    const reviewed = ['y'.repeat(100001)]
    const second = attachmentContexts(await run(added, {
      ...options,
      review: async (_input, output) => ({ output, context: reviewed, messages: [] }),
    }))
    expect(second).not.toEqual(first)
    const saved = await files()
    expect(saved).toHaveLength(2)
    expect(saved.every(name => /^mods-context-[a-f0-9]+-[a-f0-9]+\.txt$/.test(name))).toBe(true)
    expect(await Promise.all(saved.map(name => readFile(join(getToolResultsDir(), name), 'utf8')))).toEqual(expect.arrayContaining([added[0], reviewed[0]]))
    const duplicates = ['d'.repeat(100000), 'd'.repeat(100000)]
    expect(attachmentContexts(await run(duplicates))).toEqual(duplicates)
    const grouped = [...duplicates, 'd']
    await run(grouped)
    const all = await files()
    expect(all).toHaveLength(3)
    const groupFile = all.find(name => !saved.includes(name))!
    expect(JSON.parse(await readFile(join(getToolResultsDir(), groupFile), 'utf8'))).toEqual(grouped)
  })

  test('accepts and persists large context from a real Worker after review', async () => {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('tool.call', async ($, e, next) => ({ ...await next(e), context: ['worker '.repeat(15000)] }));
    }`)
    const diagnostics: string[] = []
    const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event.message) })
    let calls = 0
    try {
      await runtime.reconcile([{ name: 'large-context', storageId: 'large-context@inline', pluginRoot: root, entrypoints: [entry] }])
      const captured = runtime.capture()
      try {
        const messages = await run([], {
          snapshot: captured,
          core: async (_input, record) => {
            calls++
            record.hasResult = true
            record.result = { value: 'raw' }
            return [resultMessage(record.result)]
          },
          review: async (_input, output, context) => {
            expect(context).toEqual(['worker '.repeat(15000)])
            expect(await files()).toEqual([])
            return { output, context: ['reviewed '.repeat(15000)], messages: [] }
          },
        })
        expect(calls).toBe(1)
        expect(diagnostics).toEqual([])
        expect(attachmentContexts(messages)[0]!.startsWith('<persisted-output>')).toBe(true)
        const modelContext = messages.flatMap(({ message }) => message.type === 'attachment' ? normalizeAttachmentForAPI(message.attachment) : [])
        expect(modelContext).toHaveLength(1)
        expect(modelContext[0]!.isMeta).toBe(true)
        expect(JSON.stringify(modelContext)).toContain('<system-reminder>')
        expect(JSON.stringify(modelContext)).toContain('Full output saved to:')
        expect(JSON.stringify(modelContext).length).toBeLessThan(4000)
        const saved = await files()
        expect(saved).toHaveLength(1)
        expect(await readFile(join(getToolResultsDir(), saved[0]!), 'utf8')).toBe('reviewed '.repeat(15000))
      } finally { captured.release() }
    } finally { await runtime.dispose() }
  })

  test('persists only the selected ref after multiple downstream executions', async () => {
    let calls = 0
    const selected = 'selected'.repeat(13000)
    const discarded = 'discarded'.repeat(13000)
    const messages = await run([], {
      snapshot: snapshot(
        async (e, next) => {
          const first = await next({ ...e, value: 'selected' })
          await next({ ...e, value: 'discarded' })
          return first
        },
        async (e, next) => ({ ...await next(e) as object, context: [e.value === 'selected' ? selected : discarded] }),
      ),
      core: async (input, record) => {
        calls++
        record.hasResult = true
        record.result = input
        return [resultMessage(record.result)]
      },
      review: async (_input, output, context) => {
        expect(context).toEqual([selected])
        expect(await files()).toEqual([])
        return { output, context, messages: [] }
      },
    })
    expect(calls).toBe(2)
    expect(attachmentContexts(messages)).toHaveLength(1)
    const saved = await files()
    expect(saved).toHaveLength(1)
    expect(await readFile(join(getToolResultsDir(), saved[0]!), 'utf8')).toBe(selected)
  })

  test.each(['discarded', 'deny', 'review-deny', 'invalid-review', 'cancel-review'] as const)(
    'does not persist context from %s branches', async mode => {
      let calls = 0
      const abortController = new AbortController()
      const added = ['x'.repeat(100001)]
      const execution = run(added, {
        toolUseContext: { ...context, abortController },
        snapshot: snapshot(async (e, next) => {
          await next(e)
          if (mode === 'discarded') throw Error('discard this branch')
          if (mode === 'deny') return { deny: 'denied', context: added }
          return { result: { value: 'selected' }, context: added }
        }),
        core: async (_input, record) => {
          calls++
          record.hasResult = true
          record.result = { value: 'raw' }
          return [resultMessage(record.result)]
        },
        review: async (_input, output, context) => {
          expect(await files()).toEqual([])
          if (mode === 'cancel-review') abortController.abort(Error('cancel before persistence'))
          return { output: mode === 'invalid-review' ? { value: 123 } : output, context: mode === 'review-deny' ? [] : context, messages: [] }
        },
      })
      if (mode === 'invalid-review' || mode === 'cancel-review') await expect(execution).rejects.toThrow()
      else expect(attachmentContexts(await execution)).toEqual([])
      expect(calls).toBe(1)
      expect(await files()).toEqual([])
    },
  )

  test('write failure keeps the tool result and a bounded head with a truthful diagnostic', async () => {
    await mkdir(dirname(getToolResultsDir()), { recursive: true })
    await writeFile(getToolResultsDir(), 'not a directory')
    let calls = 0
    const original = resultMessage({ value: 'raw' })
    const messages = await run(['x'.repeat(200001)], {
      snapshot: snapshot(async (e, next) => ({ ...await next(e) as object, context: ['x'.repeat(200001)] })),
      core: async (_input, record) => {
        calls++
        record.hasResult = true
        record.result = { value: 'raw' }
        return [original]
      },
    })
    expect(calls).toBe(1)
    expect(messages[0]).toBe(original)
    const delivered = attachmentContexts(messages)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.length).toBeLessThan(3000)
    expect(delivered[0]).toContain('context persistence failed')
    expect(delivered[0]).toContain('Full context was not saved')
    expect(delivered[0]).not.toContain('Full output saved to:')
    expect(delivered[0]).not.toContain('<persisted-output>')
  })

  test('cancellation during persistence suppresses delivery and never repeats core', async () => {
    const abortController = new AbortController()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const write = fs.writeFile
    const intercepted = spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      entered.resolve()
      await finish.promise
      return write(...args)
    })
    let calls = 0
    const execution = run(['x'.repeat(100001)], {
      toolUseContext: { ...context, abortController },
      snapshot: snapshot(async (e, next) => ({ ...await next(e) as object, context: ['x'.repeat(100001)] })),
      core: async (_input, record) => {
        calls++
        record.hasResult = true
        record.result = { value: 'raw' }
        return [resultMessage(record.result)]
      },
    })
    try {
      await entered.promise
      abortController.abort(Error('cancel during persistence'))
      finish.resolve()
      await expect(execution).rejects.toThrow('cancel during persistence')
      expect(calls).toBe(1)
    } finally {
      finish.resolve()
      await execution.catch(() => {})
      intercepted.mockRestore()
    }
  })

  test('persists a context past 100000 only after review and preserves surrounding order', async () => {
    const added = ['before', 'x'.repeat(100001), 'after']
    let reviewed = false
    const messages = await run(added, {
      review: async (_input, output, context) => {
        expect(await files()).toEqual([])
        expect(context).toEqual(added)
        reviewed = true
        return { output, context, messages: [] }
      },
    })
    expect(reviewed).toBe(true)
    const delivered = attachmentContexts(messages)
    expect(delivered).toHaveLength(3)
    expect(delivered[0]).toBe('before')
    expect(delivered[2]).toBe('after')
    expect(delivered[1]!.startsWith('<persisted-output>')).toBe(true)
    expect(delivered[1]!.length).toBeLessThan(3000)
    const saved = await files()
    expect(saved).toHaveLength(1)
    expect(delivered[1]).toContain(join(getToolResultsDir(), saved[0]!))
    expect(await readFile(join(getToolResultsDir(), saved[0]!), 'utf8')).toBe(added[1])
  })
})

describe('ordinary tool.call result adapter', () => {
  test('forwards the dispatch branch signal as the third core argument', async () => {
    const branch = new AbortController()
    let received: AbortSignal | undefined
    const original = resultMessage({ value: 'raw' })
    const messages = await runModToolCall({
      snapshot: {
        hasHooks: () => true,
        release: () => {},
        dispatch: async (_event, input, core) => core(input, branch.signal),
      },
      tool,
      toolUseID: 'call-1',
      input: {},
      toolUseContext: context,
      assistantMessage: assistant,
      core: async (_input, record, signal) => {
        received = signal
        record.hasResult = true
        record.result = { value: 'raw' }
        return [original]
      },
    })
    expect(received).toBe(branch.signal)
    expect(received).not.toBe(context.abortController.signal)
    expect(messages).toEqual([original])
  })

  test('cancellation during host review prevents delivery without replaying core', async () => {
    const abortController = new AbortController()
    let calls = 0
    let mappings = 0
    await expect(runModToolCall({
      snapshot: snapshot(async (event, next) => {
        await next(event)
        return { result: { value: 'transformed' } }
      }),
      tool: {
        ...tool,
        mapToolResultToToolResultBlockParam: (output, id) => {
          mappings++
          return tool.mapToolResultToToolResultBlockParam(output, id)
        },
      },
      toolUseID: 'call-1',
      input: {},
      toolUseContext: { ...context, abortController },
      assistantMessage: assistant,
      core: async (_input, record) => {
        calls++
        record.hasResult = true
        record.result = { value: 'raw' }
        return [resultMessage(record.result)]
      },
      review: async (_input, output, context) => {
        abortController.abort(new Error('cancelled during host review'))
        return { output, messages: [], context }
      },
    })).rejects.toThrow('cancelled during host review')
    expect(calls).toBe(1)
    expect(mappings).toBe(0)
  })

  test('pins metadata and exposes arguments at the top level for every explicit next', async () => {
    const inputs: unknown[] = []
    const messages = await runModToolCall({
      snapshot: snapshot(async (e, next) => {
        expect(e).toEqual({
          value: 'original',
          tool: 'Fixture',
          tool_use_id: 'call-1',
          agentId: 'agent-test',
        })
        await next({ ...e, value: 'first' })
        return next({ ...e, value: 'second' })
      }),
      tool,
      toolUseID: 'call-1',
      input: { value: 'original' },
      toolUseContext: context,
      assistantMessage: assistant,
      core: async (input, record) => {
        inputs.push(input)
        record.input = input
        record.result = input
        record.hasResult = true
        return [resultMessage(input)]
      },
    })
    expect(inputs).toEqual([{ value: 'first' }, { value: 'second' }])
    expect(messages[0]!.message.type).toBe('user')
  })

  test('exposes numeric refs scoped to explicit downstream executions', async () => {
    const refs: unknown[] = []
    let calls = 0
    await runModToolCall({
      snapshot: snapshot(async (e, next) => {
        const first = (await next(e)) as Record<string, unknown>
        const second = (await next(e)) as Record<string, unknown>
        refs.push(first.ref, second.ref)
        return first
      }),
      tool,
      toolUseID: 'call-1',
      input: {},
      toolUseContext: context,
      assistantMessage: assistant,
      core: async (_input, record) => {
        calls++
        record.hasResult = true
        record.result = { value: String(calls) }
        return [resultMessage(record.result)]
      },
    })
    expect(refs).toEqual([1, 2])
    expect(calls).toBe(2)
  })

  test.each([
    ['string', 'not an array'],
    ['empty entry', ['']],
    ['sparse array', Array(1)],
    ['non-text entry', [123]],
  ])(
    'rejects %s context without replaying an executed tool',
    async (_name, invalid) => {
      let calls = 0
      const original = resultMessage({ value: 'raw' })
      const messages = await runModToolCall({
        snapshot: snapshot(async (e, next) => ({
          ...((await next(e)) as Record<string, unknown>),
          result: { value: 'must not replace original' },
          context: invalid,
        })),
        tool,
        toolUseID: 'call-1',
        input: {},
        toolUseContext: context,
        assistantMessage: assistant,
        core: async (_input, record) => {
          calls++
          record.hasResult = true
          record.result = { value: 'raw' }
          return [original]
        },
      })
      expect(calls).toBe(1)
      expect(messages).toEqual([original])
    },
  )

  test.each([31999, 32000, 32001, 99999, 100000])('accepts %s context characters without truncation', async length => {
    const added = ['x'.repeat(length)]
    const messages = await runModToolCall({
      snapshot: snapshot(async () => ({
        result: { value: 'synthetic' },
        context: added,
      })),
      tool,
      toolUseID: 'call-1',
      input: {},
      toolUseContext: context,
      assistantMessage: assistant,
      core: async () => {
        throw new Error('core must not run')
      },
    })
    const attachment = messages[1]!.message
    expect(
      attachment.type === 'attachment' &&
        attachment.attachment.type === 'hook_additional_context' &&
        attachment.attachment.content,
    ).toEqual(added)
  })

  test.each([
    { name: 'omitted', context: undefined },
    { name: 'empty', context: [] },
    { name: 'one duplicate missing', context: ['below'] },
  ])('retains downstream context when $name', async ({ context: removed }) => {
    let calls = 0
    const messages = await runModToolCall({
      snapshot: snapshot(
        async (e, next) => ({
          ...((await next(e)) as Record<string, unknown>),
          context: removed,
        }),
        async (e, next) => ({
          ...((await next(e)) as Record<string, unknown>),
          context: ['below', 'below'],
        }),
      ),
      tool,
      toolUseID: 'call-1',
      input: {},
      toolUseContext: context,
      assistantMessage: assistant,
      core: async (_input, record) => {
        calls++
        record.hasResult = true
        record.result = { value: 'raw' }
        return [resultMessage(record.result)]
      },
    })
    expect(calls).toBe(1)
    const attachment = messages[1]?.message
    expect(
      attachment?.type === 'attachment' &&
        attachment.attachment.type === 'hook_additional_context' &&
        attachment.attachment.content,
    ).toEqual(['below', 'below'])
  })

  test('numbers refs by completion and preserves the explicitly selected messages', async () => {
    const refs: unknown[] = []
    const originals = new Map<string, ReturnType<typeof resultMessage>>()
    let finishFirst!: () => void
    const firstPending = new Promise<void>(resolve => {
      finishFirst = resolve
    })
    const messages = await runModToolCall({
      snapshot: snapshot(async (e, next) => {
        const firstPending = next({ ...e, value: 'first' })
        const second = (await next({ ...e, value: 'second' })) as Record<
          string,
          unknown
        >
        finishFirst()
        const first = (await firstPending) as Record<string, unknown>
        refs.push(first.ref, second.ref)
        return second
      }),
      tool,
      toolUseID: 'call-1',
      input: {},
      toolUseContext: context,
      assistantMessage: assistant,
      core: async (input, record) => {
        if (input.value === 'first') await firstPending
        record.hasResult = true
        record.result = { value: 'same output' }
        const original = resultMessage(record.result)
        originals.set(input.value as string, original)
        return [original]
      },
    })
    expect(refs).toEqual([2, 1])
    expect(messages[0]).toBe(originals.get('second')!)
  })

  test('uses the referenced execution when the result record was omitted by the bridge', async () => {
    const originals: ReturnType<typeof resultMessage>[] = []
    const messages = await runModToolCall({
      snapshot: snapshot(async (e, next) => {
        const first = (await next(e)) as Record<string, unknown>
        await next(e)
        return { ref: first.ref, result: undefined }
      }),
      tool,
      toolUseID: 'call-1',
      input: {},
      toolUseContext: context,
      assistantMessage: assistant,
      core: async (_input, record) => {
        record.hasResult = true
        record.result = { value: String(originals.length) }
        const original = resultMessage(record.result)
        originals.push(original)
        return [original]
      },
    })
    expect(originals).toHaveLength(2)
    expect(messages[0]).toBe(originals[0]!)
  })

  test.each([
    { name: 'string', ref: '1' },
    { name: 'zero', ref: 0 },
    { name: 'fraction', ref: 1.5 },
    { name: 'negative', ref: -1 },
    { name: 'out of scope', ref: 2 },
  ])('rejects a $name ref without replaying core', async ({ ref }) => {
    let calls = 0
    const original = resultMessage({ value: 'raw' })
    const messages = await runModToolCall({
      snapshot: snapshot(async (e, next) => ({
        ...((await next(e)) as Record<string, unknown>),
        result: { value: 'invalid replacement' },
        ref,
      })),
      tool,
      toolUseID: 'call-1',
      input: {},
      toolUseContext: context,
      assistantMessage: assistant,
      core: async (_input, record) => {
        calls++
        record.hasResult = true
        record.result = { value: 'raw' }
        return [original]
      },
    })
    expect(calls).toBe(1)
    expect(messages[0]).toBe(original)
  })

  test.each([
    {
      name: 'selected branch',
      value: 'first',
      added: ['first'],
      expected: ['first'],
    },
    {
      name: 'changed output with all context',
      value: 'changed',
      added: ['first', 'second', 'outer'],
      expected: ['first', 'second', 'outer'],
    },
    {
      name: 'changed output dropping context',
      value: 'changed',
      added: ['first'],
      expected: ['second'],
    },
  ])(
    'preserves context across multiple next calls: $name',
    async ({ value, added, expected }) => {
      let calls = 0
      const messages = await runModToolCall({
        snapshot: snapshot(
          async (e, next) => {
            await next({ ...e, value: 'first' })
            await next({ ...e, value: 'second' })
            return { result: { value }, context: added }
          },
          async (e, next) => ({
            ...((await next(e)) as Record<string, unknown>),
            context: [e.value],
          }),
        ),
        tool,
        toolUseID: 'call-1',
        input: {},
        toolUseContext: context,
        assistantMessage: assistant,
        core: async (input, record) => {
          calls++
          record.hasResult = true
          record.result = { value: input.value }
          return [resultMessage(record.result)]
        },
      })
      expect(calls).toBe(2)
      const attachment = messages[1]?.message
      expect(
        attachment?.type === 'attachment' &&
          attachment.attachment.type === 'hook_additional_context' &&
          attachment.attachment.content,
      ).toEqual([...expected])
    },
  )

  test('preserves downstream context across the real Worker and runtime snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-tool-context-'))
    const entry = join(root, 'register.ts')
    const diagnostics: string[] = []
    const runtime = createModsRuntime({
      onDiagnostic: event => diagnostics.push(event.message),
    })
    let calls = 0
    try {
      await writeFile(
        entry,
        `export function register(on) {
        on('tool.call', async ($, e, next) => {
          const result = await next(e);
          return { ...result, context: [] };
        });
        on('tool.call', async ($, e, next) => ({
          ...await next(e), context: ['from worker', 'from worker'],
        }));
      }`,
      )
      await runtime.reconcile([
        {
          name: 'context',
          storageId: 'context@inline',
          pluginRoot: root,
          entrypoints: [entry],
        },
      ])
      const snapshot = runtime.capture()
      try {
        const messages = await runModToolCall({
          snapshot,
          tool,
          toolUseID: 'call-1',
          input: {},
          toolUseContext: context,
          assistantMessage: assistant,
          core: async (_input, record) => {
            calls++
            record.hasResult = true
            record.result = { value: 'raw' }
            return [resultMessage(record.result)]
          },
        })
        const attachment = messages[1]?.message
        expect(
          attachment?.type === 'attachment' &&
            attachment.attachment.type === 'hook_additional_context' &&
            attachment.attachment.content,
        ).toEqual(['from worker', 'from worker'])
        expect(calls).toBe(1)
        expect(diagnostics).toEqual([
          'tool.call cannot remove context attached by a downstream hook',
        ])
      } finally {
        snapshot.release()
      }
    } finally {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reuses original messages and context modifiers for value-equal VM results', async () => {
    const original = resultMessage({ value: 'raw' })
    const modifyContext = (ctx: ToolUseContext) => ctx
    const update = {
      ...original,
      contextModifier: { toolUseID: 'call-1', modifyContext },
    }
    const messages = await runModToolCall({
      snapshot: snapshot(async (e, next) => {
        const result = (await next(e)) as Record<string, unknown>
        return { ...result, result: runInNewContext('({ value: "raw" })') }
      }),
      tool,
      toolUseID: 'call-1',
      input: {},
      toolUseContext: context,
      assistantMessage: assistant,
      core: async (_input, record) => {
        record.hasResult = true
        record.result = { value: 'raw' }
        return [update]
      },
    })
    expect(messages[0]).toBe(update)
    expect(messages[0]!.message.uuid).toBe(original.message.uuid)
  })

  test('invalid transformed output recovers the last real result without replay', async () => {
    let calls = 0
    const original = resultMessage({ value: 'raw' })
    const messages = await runModToolCall({
      snapshot: snapshot(async (e, next) => {
        await next(e)
        return { result: { value: 5 } }
      }),
      tool,
      toolUseID: 'call-1',
      input: {},
      toolUseContext: context,
      assistantMessage: assistant,
      core: async (_input, record) => {
        calls++
        record.hasResult = true
        record.result = { value: 'raw' }
        return [original]
      },
    })
    expect(calls).toBe(1)
    expect(messages[0]).toBe(original)
  })

  test('does not turn permission denial into synthesized success', async () => {
    const original = resultMessage('Error: permission denied', true)
    const messages = await runModToolCall({
      snapshot: snapshot(async (e, next) => {
        await next(e)
        return { result: { value: 'forged success' } }
      }),
      tool,
      toolUseID: 'call-1',
      input: {},
      toolUseContext: context,
      assistantMessage: assistant,
      core: async () => [original],
    })
    expect(messages[0]).toBe(original)
  })

  test('maps synthesized results without invoking the core', async () => {
    const messages = await runModToolCall({
      snapshot: snapshot(async () => ({ result: { value: 'synthetic' } })),
      tool,
      toolUseID: 'call-1',
      input: {},
      toolUseContext: context,
      assistantMessage: assistant,
      core: async () => {
        throw new Error('core must not run')
      },
    })
    expect(
      (messages[0]!.message as ReturnType<typeof createUserMessage>).message
        .content,
    ).toEqual([
      { type: 'tool_result', tool_use_id: 'call-1', content: 'synthetic' },
    ])
    expect(
      messages[0]!.message.type === 'user' &&
        messages[0]!.message.sourceToolAssistantUUID,
    ).toBe(assistant.uuid)
  })

  test('maps a transformed result through its schema while retaining feedback, context and attachments', async () => {
    const original = resultMessage({ value: 'raw' })
    original.message.message.content = [
      { type: 'tool_result', tool_use_id: 'call-1', content: 'old' },
      { type: 'text', text: 'approved feedback' },
    ]
    const modifyContext = (ctx: ToolUseContext) => ctx
    const extra = {
      message: createUserMessage({
        content: 'tool additional message',
        isMeta: true,
      }),
    }
    const mappedInputs: unknown[] = []
    const messages = await runModToolCall({
      snapshot: snapshot(async (e, next) => {
        await next(e)
        return {
          result: { value: 'changed', ignored: true },
          context: ['mod context'],
        }
      }),
      tool: {
        ...tool,
        mapToolResultToToolResultBlockParam: (
          data: { value: string },
          id: string,
        ) => {
          mappedInputs.push(data)
          return { type: 'tool_result', tool_use_id: id, content: data.value }
        },
      } as Tool,
      toolUseID: 'call-1',
      input: {},
      toolUseContext: context,
      assistantMessage: assistant,
      core: async (_input, record) => {
        record.hasResult = true
        record.result = { value: 'raw' }
        return [
          {
            ...original,
            contextModifier: { toolUseID: 'call-1', modifyContext },
          },
          extra,
        ]
      },
    })
    expect(mappedInputs).toEqual([{ value: 'changed' }])
    expect(
      (messages[0]!.message as ReturnType<typeof createUserMessage>).message
        .content,
    ).toEqual([
      { type: 'tool_result', tool_use_id: 'call-1', content: 'changed' },
      { type: 'text', text: 'approved feedback' },
    ])
    expect(messages[0]!.contextModifier?.modifyContext).toBe(modifyContext)
    expect(messages[1]).toBe(extra)
    expect(
      messages[2]!.message.type === 'attachment' &&
        messages[2]!.message.attachment.type,
    ).toBe('hook_additional_context')
  })

  test('invalid synthesized output invokes downstream recovery once', async () => {
    let calls = 0
    const original = resultMessage({ value: 'raw' })
    const messages = await runModToolCall({
      snapshot: snapshot(async () => ({ result: { value: 5 } })),
      tool,
      toolUseID: 'call-1',
      input: {},
      toolUseContext: context,
      assistantMessage: assistant,
      core: async (_input, record) => {
        calls++
        record.hasResult = true
        record.result = { value: 'raw' }
        return [original]
      },
    })
    expect(calls).toBe(1)
    expect(messages[0]).toBe(original)
  })

  test('rejects a thrown real execution rewritten as successful output', async () => {
    let calls = 0
    await expect(
      runModToolCall({
        snapshot: snapshot(async (e, next) => {
          try {
            await next(e)
          } catch {
            /* The fixture deliberately tries to mask a real failure. */
          }
          return { result: { value: 'fake' } }
        }),
        tool,
        toolUseID: 'call-1',
        input: {},
        toolUseContext: context,
        assistantMessage: assistant,
        core: async () => {
          calls++
          throw new Error('real failure')
        },
      }),
    ).rejects.toThrow('real failure')
    expect(calls).toBe(1)
  })

  test('post-execution deny retains actual context changes and does not replay effects', async () => {
    let calls = 0
    const modifyContext = (ctx: ToolUseContext) => ({
      ...ctx,
      preserveToolUseResults: true,
    })
    const messages = await runModToolCall({
      snapshot: snapshot(async (e, next) => {
        await next(e)
        return { deny: 'hidden after execution' }
      }),
      tool,
      toolUseID: 'call-1',
      input: {},
      toolUseContext: context,
      assistantMessage: assistant,
      core: async (_input, record) => {
        calls++
        record.hasResult = true
        record.result = { value: 'raw' }
        return [
          {
            ...resultMessage(record.result),
            contextModifier: { toolUseID: 'call-1', modifyContext },
          },
        ]
      },
    })
    expect(calls).toBe(1)
    expect(
      (messages[0]!.message as ReturnType<typeof createUserMessage>).message
        .content,
    ).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: '<tool_use_error>hidden after execution</tool_use_error>',
        is_error: true,
      },
    ])
    expect(
      messages[0]!.contextModifier?.modifyContext(context)
        .preserveToolUseResults,
    ).toBe(true)
  })
})
