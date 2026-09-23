import { isDeepStrictEqual } from 'node:util'
import type { ProcessUserInputBaseResult } from '../../utils/processUserInput/processUserInput.js'
import type { ModDispatchOptions, ModSnapshot } from './runtime.js'
import type { ModInput } from './types.js'

export type PromptOrigin =
  | {
      kind:
        | 'composer'
        | 'bridge'
        | 'sdk'
        | 'task-notification'
        | 'scheduled-trigger'
        | 'peer'
        | 'peer-send-message'
        | 'projects-relay'
        | 'coordinator'
        | 'observer'
        | 'observer-activity'
        | 'auto-continuation'
        | 'unclassified'
        | 'slack-ping'
    }
  | { kind: 'channel'; server: string }
  | { kind: 'plugin'; name: string }

export type PromptBox = { text: string; cursor: number }
export type PromptFillMode = 'replace' | 'append' | 'insert'
export type PromptFillInput = {
  text: string
  mode: PromptFillMode
  origin: { kind: 'engine' } | { kind: 'plugin'; name: string }
}
export type PromptFillResult = { isFilled: boolean }
export type PromptFilled = PromptBox & PromptFillResult

export type ModPromptHost = {
  read(): PromptBox
  fill(input: { text: string; mode: PromptFillMode }): boolean
  isBlocked?(): boolean
}

export function emptyPromptBox(): PromptBox {
  return { text: '', cursor: 0 }
}

export function validatePromptBox(value: unknown): asserts value is PromptBox {
  const box = value as Partial<PromptBox> | null
  if (
    !box ||
    typeof box !== 'object' ||
    Array.isArray(box) ||
    typeof box.text !== 'string' ||
    typeof box.cursor !== 'number' ||
    !Number.isInteger(box.cursor) ||
    box.cursor < 0 ||
    box.cursor > box.text.length
  )
    throw new TypeError('prompt.read must return text and a valid UTF-16 cursor')
}

export function validatePromptFillInput(
  value: ModInput,
  origin: PromptFillInput['origin'],
): asserts value is PromptFillInput {
  if (
    Object.keys(value).some(key => !['text', 'mode', 'origin'].includes(key)) ||
    typeof value.text !== 'string' ||
    !['replace', 'append', 'insert'].includes(value.mode as string)
  )
    throw new TypeError('prompt.fill requires text and replace, append or insert mode')
  if (!isDeepStrictEqual(value.origin, origin))
    throw new TypeError('prompt.fill cannot rewrite origin')
}

export function applyPromptFill(
  host: ModPromptHost | undefined,
  input: Pick<PromptFillInput, 'text' | 'mode'>,
  blocked: boolean,
): PromptFillResult {
  if (!host || blocked) return { isFilled: false }
  return { isFilled: host.fill(input) }
}

export function fillPromptBox(
  host: Pick<ModPromptHost, 'read'> & {
    set(text: string, cursor: number): void
  },
  input: { text: string; mode: PromptFillMode },
): boolean {
  const box = host.read()
  validatePromptBox(box)
  const next =
    input.mode === 'replace'
      ? input.text
      : input.mode === 'append'
        ? box.text + input.text
        : box.text.slice(0, box.cursor) + input.text + box.text.slice(box.cursor)
  const cursor =
    input.mode === 'insert' ? box.cursor + input.text.length : next.length
  host.set(next, cursor)
  return true
}

export type PromptAttachment = {
  type: 'image' | 'audio' | 'document'
  mediaType?: string
  filename?: string
}

/** Ingress must carry this unchanged through the queue; uuid is not turnId. */
export type PromptSubmitMetadata = {
  origin: PromptOrigin
  wait: boolean
  turnId?: string
}

export type PromptSubmitInput = PromptSubmitMetadata & {
  text: string
  attachments?: readonly PromptAttachment[]
  context?: readonly string[]
}

export type PromptSubmitResult =
  | {
      text: string
      context?: readonly string[]
      origin?: PromptOrigin
      drop?: undefined
    }
  | { drop: string; text?: undefined; context?: undefined; origin?: undefined }

/** The dispatcher must call this at EACH next boundary, before entering below. */
export type PromptSubmitDispatchOptions = ModDispatchOptions & {
  validateInput: (input: ModInput, received: ModInput) => void
  restoreInput: (input: ModInput, received: ModInput) => ModInput
}

function validateContext(
  context: unknown,
): asserts context is readonly string[] | undefined {
  if (context === undefined) return
  if (!Array.isArray(context))
    throw new Error('prompt.submit context must be a list of texts')
  let length = 0
  for (let index = 0; index < context.length; index++) {
    if (
      !Object.hasOwn(context, index) ||
      typeof context[index] !== 'string' ||
      context[index] === ''
    )
      throw new Error('prompt.submit context must contain non-empty texts')
    length += context[index].length
  }
  if (length > 32000)
    throw new Error('prompt.submit context exceeds 32000 characters')
}

function retainContext(
  context: readonly string[] = [],
  received: readonly string[] = [],
) {
  const remaining = new Map<string, number>()
  for (const text of context)
    remaining.set(text, (remaining.get(text) ?? 0) + 1)
  for (const text of received) {
    const count = remaining.get(text) ?? 0
    if (!count) throw new Error('prompt.submit cannot remove received context')
    remaining.set(text, count - 1)
  }
}

export async function runModPromptSubmit({
  snapshot,
  input,
  core,
  signal,
  admit,
}: {
  snapshot: ModSnapshot
  input: PromptSubmitInput
  core: (input: PromptSubmitInput) => Promise<ProcessUserInputBaseResult>
  signal: AbortSignal
  admit?: (result: ProcessUserInputBaseResult) => void
}): Promise<{
  outcome: PromptSubmitResult
  submissions: ProcessUserInputBaseResult[]
}> {
  const initial = structuredClone(input)
  const submissions: ProcessUserInputBaseResult[] = []
  const pending: Promise<unknown>[] = []
  const receipts: PromptSubmitResult[] = []
  const options: PromptSubmitDispatchOptions = {
    signal,
    restoreInput(rewritten, received) {
      const restored = { ...rewritten }
      for (const key of ['origin', 'attachments', 'turnId', 'wait']) {
        if (!Object.hasOwn(restored, key) && Object.hasOwn(received, key))
          restored[key] = received[key]
      }
      return restored
    },
    validateInput(rewritten, received) {
      if (
        !rewritten ||
        typeof rewritten !== 'object' ||
        Array.isArray(rewritten) ||
        typeof rewritten.text !== 'string'
      )
        throw new Error('prompt.submit requires text')
      for (const key of ['origin', 'attachments', 'turnId', 'wait'] as const) {
        if (!isDeepStrictEqual(rewritten[key], initial[key]))
          throw new Error(`prompt.submit cannot rewrite ${key}`)
      }
      validateContext(rewritten.context)
      retainContext(
        rewritten.context,
        received.context as readonly string[] | undefined,
      )
    },
    validateResult(value, nextResults = []) {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('prompt.submit must return text or drop')
      const result = value as PromptSubmitResult
      if (result.drop !== undefined) {
        if (
          typeof result.drop !== 'string' ||
          result.text !== undefined ||
          result.context !== undefined ||
          result.origin !== undefined
        )
          throw new Error(
            'prompt.submit drop must be a reason without text, context or origin',
          )
        return
      }
      if (typeof result.text !== 'string')
        throw new Error('prompt.submit must return text or drop')
      validateContext(result.context)
      if (
        result.origin !== undefined &&
        !isDeepStrictEqual(result.origin, initial.origin)
      )
        throw new Error('prompt.submit cannot set another origin')
      for (const below of nextResults as readonly PromptSubmitResult[]) {
        if (below.drop === undefined)
          retainContext(result.context, below.context)
      }
      if (
        nextResults.length &&
        !receipts.some(
          receipt =>
            receipt.drop === undefined &&
            receipt.text === result.text &&
            isDeepStrictEqual(receipt.context ?? [], result.context ?? []),
        )
      )
        throw new Error(
          'prompt.submit result changed after next; the submitted prompt is unchanged',
        )
    },
  }
  let outcome: unknown
  try {
    outcome = await snapshot.dispatch(
      'prompt.submit',
      structuredClone(initial),
      rewritten => {
        signal.throwIfAborted()
        // Also guard core until all runtime callers forward validateInput. Only
        // the dispatcher can enforce context retention between adjacent hooks.
        options.validateInput(rewritten, initial)
        const entered = structuredClone(rewritten) as PromptSubmitInput
        const index = pending.length
        const execution = (async () => {
          const result = await core(entered)
          const receipt: PromptSubmitResult = result.shouldQuery
            ? {
                text: entered.text,
                ...(entered.context === undefined
                  ? {}
                  : { context: [...entered.context] }),
                origin: entered.origin,
              }
            : {
                drop:
                  result.resultText ??
                  'Prompt blocked by UserPromptSubmit hook',
              }
          submissions[index] = { ...result, admission: structuredClone(receipt) }
          receipts.push(structuredClone(receipt))
          // Commit before next resolves; its caller must not await a model turn.
          admit?.(submissions[index]!)
          return receipt
        })()
        pending.push(execution)
        return execution
      },
      options,
    )
  } finally {
    // Unawaited next and cancellation must not release the snapshot while a
    // classic hook is still running, nor replay its already-executed effects.
    await Promise.allSettled(pending)
  }
  signal.throwIfAborted()
  return {
    outcome: outcome as PromptSubmitResult,
    submissions: submissions.filter(Boolean),
  }
}
