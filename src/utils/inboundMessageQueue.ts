import type { QueuedCommand } from '../types/textInputTypes.js'
import { validateSessionReceiveResult, type SessionReceiveInput, type SessionReceiveOrigin, type SessionReceiveResult } from '../services/mods/receiveAdapter.js'
import { enqueue } from './messageQueueManager.js'
import { getSessionId } from '../bootstrap/state.js'

export type InboundMessageReceiver = (
  input: SessionReceiveInput,
  admit: (input: SessionReceiveInput) => void | SessionReceiveResult | Promise<void | SessionReceiveResult>,
  signal?: AbortSignal,
) => Promise<SessionReceiveResult>

let receiver: InboundMessageReceiver | undefined
let ready: Promise<void> | undefined
let markReady: (() => void) | undefined

/** The inbox starts before the trusted conversation host is constructed. */
export function deferInboundMessages(): void {
  if (!ready) ready = new Promise(resolve => { markReady = resolve })
}

export function setInboundMessageReceiver(next: InboundMessageReceiver): () => void {
  receiver = next
  markReady?.()
  ready = undefined
  markReady = undefined
  return () => { if (receiver === next) receiver = undefined }
}

/** For sanitized external deliveries only; ordinary enqueue remains synchronous. */
export async function enqueueInboundMessage(
  command: QueuedCommand,
  origin: SessionReceiveOrigin,
  options: {
    event?: SessionReceiveInput['event']
    signal?: AbortSignal
    enqueue?: (command: QueuedCommand) => void | SessionReceiveResult
  } = {},
): Promise<SessionReceiveResult> {
  const sessionId = getSessionId()
  options.signal?.throwIfAborted()
  if (ready) {
    let abort: (() => void) | undefined
    try {
      await Promise.race([ready, new Promise<never>((_, reject) => {
        abort = () => reject(options.signal!.reason)
        options.signal?.addEventListener('abort', abort, { once: true })
      })])
    } finally {
      if (abort) options.signal?.removeEventListener('abort', abort)
    }
  }
  options.signal?.throwIfAborted()
  const original = command.value
  const text = typeof original === 'string' ? original : original.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const input: SessionReceiveInput = { origin, text, ...(options.event ? { event: options.event } : {}) }
  const admit = (rewritten: SessionReceiveInput) => {
    options.signal?.throwIfAborted()
    if (getSessionId() !== sessionId) throw new Error('Inbound delivery session changed')
    let value = original
    if (rewritten.text !== text) {
      // Preserve media and untouched text-block boundaries on the no-op path.
      value = typeof original === 'string' ? rewritten.text : [
        { type: 'text', text: rewritten.text },
        ...original.filter(block => block.type !== 'text'),
      ]
    }
    return (options.enqueue ?? enqueue)({
      ...command,
      value,
      promptSubmitMetadata: { origin, wait: false },
    })
  }
  if (receiver) return receiver(input, admit, options.signal)
  const result: void | SessionReceiveResult = admit(input)
  if (result === undefined) return { text }
  validateSessionReceiveResult(result)
  return result as SessionReceiveResult
}
