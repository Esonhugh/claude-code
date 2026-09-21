import type { AssistantMessage, Message, StreamEvent } from '../../types/message.js'
import type { ModSnapshot } from './runtime.js'
import type { ModInput } from './types.js'

type TurnUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}
type TurnCompleteResult = { text: string; usage?: TurnUsage }
const tokenFields = [
  'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
] as const

function validateResult(value: unknown): asserts value is TurnCompleteResult {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    typeof (value as TurnCompleteResult).text !== 'string')
    throw new Error('turn.complete must return an object with text')
  const { usage } = value as TurnCompleteResult
  if (usage !== undefined && (!usage || typeof usage !== 'object' || Array.isArray(usage) ||
    typeof usage.model !== 'string' || tokenFields.some(field =>
      !Number.isFinite(usage[field]) || usage[field] < 0)))
    throw new Error('turn.complete usage must contain model and non-negative finite token counts')
}

/** Observes model responses, not the transcript (which also contains synthetic messages). */
export function createModTurnCompletion(turnId: string, agentId?: string) {
  type Response = {
    messages: Map<string, AssistantMessage>
    stream?: AssistantMessage['message']
    textBlocks?: Map<number, string>
    deltaUsage?: Partial<TurnUsage>
    stopReason?: string
    refusal?: { category?: unknown; explanation?: unknown }
  }
  const responses = new Map<string, Response>()
  let current: Response | undefined
  let apiError = false
  function response(id: string) {
    let value = responses.get(id)
    if (!value) {
      value = { messages: new Map() }
      responses.set(id, value)
    }
    current = value
    return value
  }

  function observe(message: Message | StreamEvent) {
    if (message.type === 'assistant') {
      apiError = message.isApiErrorMessage === true
      if (apiError || message.isVirtual || message.message.model === '<synthetic>') return
      response(message.message.id).messages.set(message.uuid, message)
    } else if (message.type === 'stream_event') {
      const event = message.event as {
        type: string
        message?: AssistantMessage['message']
        usage?: Partial<TurnUsage>
        index?: number
        content_block?: { type: string; text?: string }
        delta?: { type?: string; text?: string; stop_reason?: string; stop_details?: Response['refusal'] }
      } | undefined
      if (event?.type === 'message_start' && event.message) {
        apiError = false
        response(event.message.id).stream = event.message
      } else if (event?.type === 'content_block_start' && current && event.index !== undefined) {
        current.textBlocks ??= new Map()
        if (event.content_block?.type === 'text')
          current.textBlocks.set(event.index, event.content_block.text ?? '')
      } else if (event?.type === 'content_block_delta' && current && event.index !== undefined &&
        event.delta?.type === 'text_delta') {
        current.textBlocks ??= new Map()
        current.textBlocks.set(event.index, (current.textBlocks.get(event.index) ?? '') + (event.delta.text ?? ''))
      } else if (event?.type === 'message_delta' && current) {
        current.stopReason = event.delta?.stop_reason ?? current.stopReason
        current.refusal = event.delta?.stop_details ?? current.refusal
        if (event.usage) {
          current.deltaUsage ??= {}
          for (const field of tokenFields) {
            const count = event.usage[field]
            if (typeof count === 'number')
              current.deltaUsage[field] = Math.max(current.deltaUsage[field] ?? 0, count)
          }
        }
      }
    }
  }

  async function complete(snapshot: ModSnapshot, end: {
    durationMs: number
    aborted: boolean
    failed: boolean
    terminal?: { reason?: string }
  }): Promise<{ input: ModInput; result: TurnCompleteResult }> {
    let answer = ''
    let usage: TurnUsage | undefined
    let last: AssistantMessage['message'] | undefined
    for (const value of responses.values()) {
      const messages = [...value.messages.values()]
      const sources = [...(value.stream ? [value.stream] : []), ...messages.map(item => item.message)]
      last = sources.at(-1)
      // A UUID identifies one yielded block (or a replacement snapshot of it).
      // Only blocks belonging to the last API message form the final answer.
      answer = value.textBlocks
        ? [...value.textBlocks].sort(([a], [b]) => a - b).map(([, text]) => text).join('')
        : messages.flatMap(item => item.message.content)
          .filter(block => block.type === 'text')
          .map(block => block.text ?? '').join('')
      const counts = [...sources.map(item => item.usage), value.deltaUsage].filter(Boolean)
      if (!last || !counts.length) continue
      usage ??= { model: last.model, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      usage.model = last.model
      // Each response's usage is cumulative, including snapshots emitted for
      // separate blocks. Read retained references here: message_delta mutates them.
      for (const field of tokenFields)
        usage[field] += Math.max(0, ...counts.map(count => count?.[field] ?? 0))
    }
    const stopReason = current?.stopReason ?? last?.stop_reason
    const isAborted = end.aborted || end.terminal?.reason?.startsWith('aborted') === true
    const reason = isAborted ? 'aborted'
      : end.failed ? 'error'
      : stopReason === 'refusal' ? 'refusal'
      : apiError || ['model_error', 'image_error', 'blocking_limit', 'prompt_too_long'].includes(end.terminal?.reason ?? '') ? 'error'
      : 'answer'
    const refusal = current?.refusal ?? (last as (AssistantMessage['message'] & { stop_details?: Response['refusal'] }) | undefined)?.stop_details
    const input: ModInput = {
      answer, durationMs: end.durationMs, turnId, isAborted, reason,
      ...(agentId === undefined ? {} : { agentId }),
      ...(usage ? { usage } : {}),
      ...(reason === 'refusal' ? { refusal: {
        category: typeof refusal?.category === 'string' ? refusal.category : null,
        explanation: typeof refusal?.explanation === 'string' ? refusal.explanation : null,
      } } : {}),
    }
    const result = await snapshot.dispatch('turn.complete', input, async rewritten => {
      if (rewritten.agentId !== agentId)
        throw new Error('turn.complete cannot rewrite agentId')
      return { text: rewritten.answer, ...(rewritten.usage === undefined ? {} : { usage: rewritten.usage }) }
    }, {
      // Completion is cleanup. Runtime dispatch still applies its own lifetime
      // signal; forwarding the interrupted query's signal would skip every hook.
      validateResult,
    })
    validateResult(result)
    return { input, result }
  }
  return { observe, complete }
}
