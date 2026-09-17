import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { runInNewContext } from 'node:vm'
import type { Tool, ToolUseContext } from '../../Tool.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../utils/messages.js'
import { dispatchModEvent } from './dispatch.js'
import type { ModDispatchHook } from './types.js'
import { runModToolCall } from './toolAdapter.js'
import { createModsRuntime } from './runtime.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

describe('ordinary tool.call result adapter', () => {
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
    ['over budget', ['x'.repeat(32001)]],
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

  test('accepts exactly 32000 context characters without truncation', async () => {
    const added = ['x'.repeat(16000), 'y'.repeat(16000)]
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
