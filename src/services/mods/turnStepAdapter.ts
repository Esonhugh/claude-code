import { randomUUID } from 'node:crypto'
import type {
  AssistantMessage,
  ContentBlockParam,
  Message,
  StreamEvent,
} from '../../types/message.js'
import type { ModSnapshot } from './runtime.js'
import type { ModInput, ModTurnStepChunk, ModTurnStepResult, ModTurnUsage } from './types.js'

type ModelItem = (Message | StreamEvent) & { isModTurnStep?: boolean }
type ModelEvent = {
  type: string
  index?: number
  message?: AssistantMessage['message']
  content_block?: ContentBlockParam
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: ModTurnStepResult['stopReason']
    [key: string]: unknown
  }
  usage?: Partial<ModTurnUsage>
}
type Reference = { item: ModelItem; indices?: number[] }
type Block = {
  start?: StreamEvent
  original?: AssistantMessage
  originalBlock?: ContentBlockParam
  kind?: 'text' | 'thinking' | 'tool'
  text: string
  json: string
  id?: string
  name?: string
  started: boolean
  closed: boolean
}
const tokenFields = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const
function usageOf(message?: AssistantMessage['message']): ModTurnUsage | null {
  if (!message?.usage) return null
  return {
    model: message.model,
    ...Object.fromEntries(tokenFields.map(key => [key, message.usage[key] ?? 0])),
  } as ModTurnUsage
}

/** The only bridge between the opaque model stream and the chunks leaving turn.step. */
export async function* streamModTurnStep(
  snapshot: ModSnapshot,
  input: ModInput,
  callModel: (input: ModInput, signal?: AbortSignal) => AsyncGenerator<ModelItem>,
  signal: AbortSignal,
): AsyncGenerator<ModelItem> {
  const references = new Map<number, Reference>()
  let nextRef = 0
  function remember(item: ModelItem, indices?: number[]) {
    const ref = nextRef++
    references.set(ref, { item, indices })
    return ref
  }
  async function* core(
    value: ModInput,
    signal?: AbortSignal,
  ): AsyncGenerator<ModTurnStepChunk, ModTurnStepResult> {
    let envelope: AssistantMessage['message'] | undefined
    let completed: AssistantMessage[] = []
    let nextIndex = 0
    let emittedStop = false
    let messageOpen = false
    const streamingIndices = new Set<number>()
    const pending = new Map<number, ContentBlockParam>()
    const text = new Map<number, string>()
    let stopReason: ModTurnStepResult['stopReason'] = null
    let usage: ModTurnUsage | null = null
    for await (const item of callModel(value, signal)) {
      if (item.type === 'assistant' && !item.isApiErrorMessage && !item.isVirtual) {
        if (!messageOpen) {
          envelope = item.message
          messageOpen = true
          yield { kind: 'engine', ref: remember({
            type: 'stream_event',
            event: { type: 'message_start', message: { ...envelope, content: [] } },
          }) }
        }
        completed.push(item)
        const indices: number[] = []
        for (const block of item.message.content) {
          const found = [...pending].find(
            ([, start]) =>
              start.type === block.type && (block.type !== 'tool_use' || start.id === block.id),
          )
          const index = found?.[0] ?? nextIndex++
          indices.push(index)
          if (found) pending.delete(index)
          else {
            // Non-streaming fallback returns completed blocks, not SSE deltas.
            const ref = remember({ ...item, message: { ...item.message, content: [block] } }, [
              index,
            ])
            if (block.type === 'text') yield { kind: 'text', index, text: block.text ?? '', ref }
            else if (block.type === 'thinking')
              yield { kind: 'thinking', index, text: String(block.thinking ?? ''), ref }
            else if (block.type === 'tool_use') {
              yield { kind: 'tool', index, id: block.id!, name: block.name!, ref }
              yield { kind: 'input', index, json: JSON.stringify(block.input) ?? '', ref }
            }
          }
        }
        yield { kind: 'engine', ref: remember(item, indices) }
        // The completed block is followed by its raw stop in streaming mode.
        for (const index of indices) {
          if (!streamingIndices.has(index))
            yield {
              kind: 'engine',
              ref: remember({ type: 'stream_event', event: { type: 'content_block_stop', index } }),
            }
        }
        continue
      }
      const event =
        item.type === 'stream_event' ? (item.event as ModelEvent | undefined) : undefined
      const ref = remember(item)
      if (event?.type === 'message_stop') messageOpen = false
      if (event?.type === 'message_start' && event.message) {
        messageOpen = true
        envelope = event.message
        completed = []
        nextIndex = 0
        pending.clear()
        text.clear()
        streamingIndices.clear()
        emittedStop = false
        stopReason = null
        usage = usageOf(envelope)
      }
      if (
        event?.type === 'content_block_start' &&
        event.index !== undefined &&
        event.content_block
      ) {
        pending.set(event.index, event.content_block)
        streamingIndices.add(event.index)
        nextIndex = Math.max(nextIndex, event.index + 1)
        if (event.content_block.type === 'tool_use') {
          yield {
            kind: 'tool',
            index: event.index,
            id: event.content_block.id!,
            name: event.content_block.name!,
            ref,
          }
          continue
        }
      }
      if (event?.type === 'content_block_delta' && event.index !== undefined) {
        if (event.delta?.type === 'text_delta') {
          text.set(event.index, (text.get(event.index) ?? '') + event.delta.text!)
          yield { kind: 'text', index: event.index, text: event.delta.text!, ref }
          continue
        }
        if (event.delta?.type === 'thinking_delta') {
          yield { kind: 'thinking', index: event.index, text: event.delta.thinking!, ref }
          continue
        }
        if (
          event.delta?.type === 'input_json_delta' &&
          pending.get(event.index)?.type === 'tool_use'
        ) {
          yield { kind: 'input', index: event.index, json: event.delta.partial_json!, ref }
          continue
        }
      }
      if (event?.type === 'message_delta') {
        stopReason = event.delta?.stop_reason ?? stopReason
        const source = completed.at(-1)?.message ?? envelope
        usage = usageOf(source) ?? usage
        if (usage && event.usage)
          for (const key of tokenFields) usage[key] = event.usage[key] ?? usage[key]
        emittedStop = true
        yield { kind: 'stop', stopReason, usage, ref }
      } else yield { kind: 'engine', ref }
    }
    const last = completed.at(-1)?.message ?? envelope
    stopReason ??= (last?.stop_reason as ModTurnStepResult['stopReason']) ?? null
    usage = usage ?? usageOf(last)
    if (last && !emittedStop) yield { kind: 'stop', stopReason, usage }
    if (messageOpen) yield {
      kind: 'engine', ref: remember({type: 'stream_event', event: {type: 'message_stop'}}),
    }
    return {
      turnId: value.turnId as string,
      index: value.index as number,
      answer: completed.length
        ? completed
            .flatMap(item => item.message.content)
            .filter(block => block.type === 'text')
            .map(block => block.text ?? '')
            .join('')
        : [...text.values()].join(''),
      toolUses: completed
        .flatMap(item => item.message.content)
        .filter(block => block.type === 'tool_use')
        .map(block => ({ name: block.name!, input: block.input })),
      stopReason,
      usage,
    }
  }
  let envelope: AssistantMessage['message'] | undefined
  let started = false
  let stopped = false
  let stop: Extract<ModTurnStepChunk, { kind: 'stop' }> | undefined
  const blocks = new Map<number, Block>()
  const emitted: AssistantMessage[] = []
  function blockAt(index: number) {
    let block = blocks.get(index)
    if (!block) {
      block = { text: '', json: '', started: false, closed: false }
      blocks.set(index, block)
    }
    return block
  }
  function* startMessage(): Generator<StreamEvent> {
    if (started) return
    envelope ??= {
      id: `mod-${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: input.model as string,
      content: [],
      stop_reason: null,
      stop_sequence: null,
    } as AssistantMessage['message']
    started = true
    yield {
      type: 'stream_event',
      event: { type: 'message_start', message: { ...envelope, content: [] } },
    }
  }
  function* startBlock(index: number, block: Block): Generator<ModelItem> {
    yield* startMessage()
    if (block.started) return
    block.started = true
    const original = (block.start?.event as ModelEvent | undefined)?.content_block
    const content_block =
      block.kind === 'tool'
        ? { ...original, type: 'tool_use', id: block.id, name: block.name, input: {} }
        : block.kind === 'thinking'
          ? { ...original, type: 'thinking', thinking: '', signature: '' }
          : { ...original, type: 'text', text: '' }
    yield {
      ...block.start,
      isModTurnStep: true,
      type: 'stream_event',
      event: { type: 'content_block_start', index, content_block },
    }
  }
  function* closeBlock(index: number): Generator<ModelItem> {
    const block = blocks.get(index)
    if (!block || block.closed) return
    block.closed = true
    let content: ContentBlockParam | undefined
    if (
      block.originalBlock?.type === 'thinking' ||
      block.originalBlock?.type === 'redacted_thinking'
    )
      content = block.originalBlock
    else if (block.kind === 'text')
      content = { ...block.originalBlock, type: 'text', text: block.text }
    else if (block.kind === 'tool') {
      let parsed: unknown = block.json
      try {
        parsed = JSON.parse(block.json || '{}')
      } catch {
        /* Invalid JSON must fail tool input validation, not become runnable {}. */
      }
      content = {
        ...block.originalBlock,
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: parsed,
      }
    } else if (
      block.originalBlock &&
      !['text', 'tool_use', 'thinking'].includes(block.originalBlock.type)
    )
      content = block.originalBlock
    if (content) {
      if (content.type === 'thinking' && !block.started) {
        // No visible chunks survived; keep the signed history without displaying it.
        block.kind = 'thinking'
        yield* startBlock(index, block)
      }
      yield* startMessage()
      const message: AssistantMessage & { isModTurnStep: true } = {
        ...block.original,
        isModTurnStep: true,
        type: 'assistant',
        uuid: block.original?.message.content.length === 1 ? block.original.uuid : randomUUID(),
        timestamp: block.original?.timestamp ?? new Date().toISOString(),
        message: { ...(block.original?.message ?? envelope!), content: [content] },
      }
      emitted.push(message)
      yield message
    }
    if (block.started) yield { type: 'stream_event', isModTurnStep: true, event: { type: 'content_block_stop', index } }
  }
  function syncMetadata() {
    for (const message of emitted) {
      if (stop) {
        message.message.stop_reason = stop.stopReason
        if (stop.usage) {
          message.message.usage = { ...message.message.usage, ...stop.usage }
          message.message.model = stop.usage.model
        }
      } else {
        const original = [...blocks.values()].find(
          block => block.original?.uuid === message.uuid,
        )?.original
        if (original) {
          message.message.usage = original.message.usage
          message.message.stop_reason = original.message.stop_reason
        }
      }
    }
  }
  const stream = snapshot.stream!('turn.step', input, core, { signal })
  let aborted: { error: unknown } | undefined
  try {
    for await (const value of stream) {
      const chunk = value as ModTurnStepChunk
      const reference = chunk.ref === undefined ? undefined : references.get(chunk.ref)
      if (reference?.item.type === 'assistant') envelope ??= reference.item.message
      if (chunk.kind === 'engine') {
        if (!reference) continue
        const item = reference.item
        if (item.type === 'assistant' && reference.indices) {
          for (let i = 0; i < reference.indices.length; i++) {
            const block = blockAt(reference.indices[i]!)
            block.original = item
            block.originalBlock = item.message.content[i]
          }
          envelope ??= item.message
          continue
        }
        const event =
          item.type === 'stream_event' ? (item.event as ModelEvent | undefined) : undefined
        if (event?.type === 'message_start') {
          for (const index of blocks.keys()) yield* closeBlock(index)
          syncMetadata()
          blocks.clear()
          emitted.length = 0
          started = false
          stopped = false
          stop = undefined
          envelope = event.message
          yield* startMessage()
        } else if (event?.type === 'content_block_start' && event.index !== undefined) {
          const block = blockAt(event.index)
          block.start = item as StreamEvent
          if (!['text', 'thinking', 'tool_use'].includes(event.content_block?.type ?? '')) {
            yield* startMessage()
            block.started = true
            yield item
          }
        } else if (event?.type === 'content_block_stop' && event.index !== undefined)
          yield* closeBlock(event.index)
        else if (event?.type === 'message_stop') {
          for (const index of blocks.keys()) yield* closeBlock(index)
          syncMetadata()
          if (started) {
            stopped = true
            yield item
          }
        } else if (event?.type === 'content_block_delta' && event.index !== undefined) {
          if (blocks.get(event.index)?.started) yield item
        } else yield item
        continue
      }
      if (chunk.kind === 'stop') {
        for (const index of blocks.keys()) yield* closeBlock(index)
        stop = chunk
        syncMetadata()
        yield* startMessage()
        const original = reference?.item.type === 'stream_event' ? reference.item : undefined
        const event = original?.event as ModelEvent | undefined
        yield {
          ...original,
          type: 'stream_event',
          event: {
            ...event,
            type: 'message_delta',
            delta: { ...event?.delta, stop_reason: chunk.stopReason },
            usage: chunk.usage ?? undefined,
          },
        }
        continue
      }
      const block = blockAt(chunk.index)
      if (block.closed) continue
      if (chunk.kind === 'input') {
        // Dropping the tool start also drops its arguments and execution.
        if (block.kind !== 'tool') continue
        block.json += chunk.json
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: chunk.index,
            delta: { type: 'input_json_delta', partial_json: chunk.json },
          },
        }
        continue
      }
      if (chunk.kind === 'tool') {
        block.kind = 'tool'
        block.id = chunk.id
        block.name = chunk.name
        if (reference?.item.type === 'stream_event') block.start = reference.item
      } else {
        block.kind = chunk.kind
        block.text += chunk.text
      }
      yield* startBlock(chunk.index, block)
      if (chunk.kind !== 'tool')
        yield {
          type: 'stream_event',
          isModTurnStep: true,
          event: {
            type: 'content_block_delta',
            index: chunk.index,
            delta:
              chunk.kind === 'text'
                ? { type: 'text_delta', text: chunk.text }
                : { type: 'thinking_delta', thinking: chunk.text },
          },
        }
    }
  } catch (error) {
    if (!signal.aborted || (error !== signal.reason &&
      !(error instanceof Error && error.name === 'AbortError'))) throw error
    aborted = { error }
  }
  // A hook can omit all engine chunks, or supply an entirely new response.
  // Its return value is deliberately not consumed as output or history.
  for (const index of blocks.keys()) yield* closeBlock(index)
  syncMetadata()
  if (started && !stopped) yield { type: 'stream_event', event: { type: 'message_stop' } }
  if (aborted) throw aborted.error
}
