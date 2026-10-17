import { isDeepStrictEqual } from 'node:util'
import type { Message, UserMessage } from '../../types/message.js'
import {
  attachmentMessagesForAPI,
  normalizeAttachmentForAPI,
  wrapInSystemReminder,
} from '../../utils/messages.js'
import type { ModSnapshot } from './runtime.js'

type AttachmentResult = { text: string | null }

function validateAttachmentResult(
  value: unknown,
): asserts value is AttachmentResult {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('text' in value) ||
    (value.text !== null && typeof value.text !== 'string')
  )
    throw new TypeError('prompt.attachment must return text or null')
}

export async function renderModPromptAttachments(
  messages: Message[],
  snapshot: ModSnapshot,
  signal: AbortSignal,
  agentId?: string,
): Promise<Message[]> {
  if (!snapshot.hasHooks('prompt.attachment')) return messages
  const cache = snapshot.promptAttachments ?? new Map()
  const result: Message[] = []
  for (const message of messages) {
    signal.throwIfAborted()
    if (message.type !== 'attachment') {
      result.push(message)
      continue
    }
    const rendered = normalizeAttachmentForAPI(message.attachment)
    const texts = rendered.flatMap((item) =>
      typeof item.message.content === 'string'
        ? [item.message.content]
        : item.message.content.flatMap((block) =>
            block.type === 'text' && typeof block.text === 'string'
              ? [block.text]
              : [],
          ),
    )
    if (!texts.length) {
      result.push(message)
      continue
    }
    const prefix = '<system-reminder>\n',
      suffix = '\n</system-reminder>'
    const unframe = (text: string) =>
      text.startsWith(prefix) && text.endsWith(suffix)
        ? text.slice(prefix.length, -suffix.length)
        : text
    const text = texts.map(unframe).join('\n')
    const attachment = message.attachment
    const origin =
      attachment.type === 'hook_additional_context' && attachment.modEvent
        ? { kind: 'plugin', event: attachment.modEvent }
        : 'hookEvent' in attachment
          ? { kind: 'hook', event: attachment.hookEvent }
          : { kind: 'engine' }
    const key = JSON.stringify([agentId, message.uuid])
    async function read(): Promise<AttachmentResult> {
      signal.throwIfAborted()
      let pending = cache.get(key)
      if (!pending || pending.signal.aborted) {
        const input = {
          type: attachment.type,
          text,
          origin,
          ...(agentId === undefined ? {} : { agentId }),
        }
        const result = snapshot
          .dispatch(
            'prompt.attachment',
            input,
            async (value) => ({ text: value.text }),
            {
              signal,
              restoreInput(value, received) {
                const restored = { ...value }
                for (const key of ['type', 'origin', 'agentId']) {
                  if (
                    !Object.hasOwn(restored, key) &&
                    Object.hasOwn(received, key)
                  )
                    restored[key] = received[key]
                }
                return restored
              },
              validateInput(value) {
                for (const key of ['type', 'origin', 'agentId'] as const) {
                  if (!isDeepStrictEqual(value[key], input[key]))
                    throw new Error(`prompt.attachment cannot rewrite ${key}`)
                }
                if (typeof value.text !== 'string')
                  throw new TypeError('prompt.attachment requires text')
              },
              validateResult: validateAttachmentResult,
            },
          )
          .then((value) => {
            validateAttachmentResult(value)
            return { text: value.text }
          })
        pending = { result, signal }
        cache.set(key, pending)
        const entry = pending
        void result.catch(() => {
          if (cache.get(key) === entry) cache.delete(key)
        })
      }
      const entry = pending
      const owner = entry.signal
      let abort = () => {}
      try {
        const answer = await Promise.race([
          entry.result,
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(signal.aborted ? signal.reason : owner.reason)
            signal.addEventListener('abort', abort, { once: true })
            if (owner !== signal)
              owner.addEventListener('abort', abort, { once: true })
            if (signal.aborted || owner.aborted) abort()
          }),
        ])
        signal.throwIfAborted()
        return answer
      } catch (error) {
        if (!signal.aborted && owner.aborted) {
          if (cache.get(key) === entry) cache.delete(key)
          return read()
        }
        throw error
      } finally {
        signal.removeEventListener('abort', abort)
        owner.removeEventListener('abort', abort)
      }
    }
    const answer = await read()
    let projected = rendered
    if (answer.text === null) projected = []
    else if (answer.text !== text) {
      let written = false
      projected = rendered.flatMap((item) => {
        const blocks =
          typeof item.message.content === 'string'
            ? [{ type: 'text', text: item.message.content }]
            : item.message.content
        const content = blocks.flatMap((block) => {
          if (block.type !== 'text') return [block]
          if (written) return []
          written = true
          return [
            {
              ...block,
              text: texts.some((value) => unframe(value) !== value)
                ? wrapInSystemReminder(answer.text!)
                : answer.text!,
            },
          ]
        })
        return content.length
          ? [{ ...item, message: { ...item.message, content } } as UserMessage]
          : []
      })
    }
    const requestMessage = { ...message }
    attachmentMessagesForAPI.set(requestMessage, projected)
    result.push(requestMessage)
  }
  return result
}
