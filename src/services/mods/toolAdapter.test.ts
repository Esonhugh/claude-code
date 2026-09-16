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

function snapshot(invoke: ModDispatchHook['invoke']) {
  return {
    hasHooks: () => true,
    release: () => {},
    dispatch: (
      event: string,
      input: Record<string, unknown>,
      core: (input: Record<string, unknown>) => Promise<unknown>,
      options?: {
        signal?: AbortSignal
        validateResult?: (value: unknown) => void
      },
    ) =>
      dispatchModEvent({
        event,
        input,
        core,
        ...options,
        hooks: [
          {
            plugin: 'test',
            tier: 'user',
            registration: { id: 1, event, hasCatch: false },
            invoke,
          },
        ],
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
          context: 'mod context',
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
          } catch { /* The fixture deliberately tries to mask a real failure. */ }
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
