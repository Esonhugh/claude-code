import { copyModCallerChain, type ModCallerChain } from './callerChain.js'
import { isDeepStrictEqual } from 'node:util'
import type { ProcessUserInputBaseResult } from '../../utils/processUserInput/processUserInput.js'
import type { ModDispatchOptions, ModSnapshot } from './runtime.js'
import type { ModInput } from './types.js'
import { normalizePromptDecorations, validatePromptDecorations, type PromptDecoration } from './promptEdit.js'

export const UNSUBMITTED_PROMPT_DROP = 'the prompt did not go through prompt.submit (a command, bash mode, an input that did not query, or a failed pass)'
export const FAILED_PROMPT_BATCH_DROP = 'an earlier prompt in the batch failed'

export type PromptOrigin =
  | { kind: 'composer' }
  | { kind: 'bridge' }
  | { kind: 'sdk' }
  | { kind: 'task-notification' }
  | { kind: 'scheduled-trigger' }
  | { kind: 'peer' }
  | { kind: 'peer-send-message' }
  | { kind: 'projects-relay' }
  | { kind: 'coordinator' }
  | { kind: 'observer' }
  | { kind: 'observer-activity' }
  | { kind: 'auto-continuation' }
  | { kind: 'unclassified' }
  | { kind: 'slack-ping' }
  | {kind:'peer'|'coordinator';plugin?:string;teammate?:string;isVerified?:boolean}
  | { kind: 'channel'; server: string }
  | { kind: 'plugin'; name: string; asUser?: true }

export type PromptBox = { text: string; cursor: number }
export type PromptFillMode = 'replace' | 'append' | 'insert'
export type PromptFillInput = {
  text: string
  mode: PromptFillMode
  decorations?: PromptDecoration[]
  origin: { kind: 'engine' } | { kind: 'plugin'; name: string }
}
export type PromptFillResult = { isFilled: boolean; refusal?: 'no_composer' | 'dialog' }
export type PromptFilled = PromptBox & PromptFillResult

export type ModPromptHost = {
  read(): PromptBox
  fill(input: Pick<PromptFillInput, 'text' | 'mode' | 'decorations'>): boolean
  suggest?(text: string, owner: string): boolean | Promise<boolean>
  clearSuggestion?(owner: string): void
  canSuggest?(): boolean
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
    Object.keys(value).some(key => !['text', 'mode', 'origin', 'decorations'].includes(key)) ||
    typeof value.text !== 'string' ||
    !['replace', 'append', 'insert'].includes(value.mode as string)
  )
    throw new TypeError('prompt.fill requires text and replace, append or insert mode')
  if (!isDeepStrictEqual(value.origin, origin))
    throw new TypeError('prompt.fill cannot rewrite origin')
  validatePromptDecorations(value.decorations)
}

export function applyPromptFill(
  host: ModPromptHost | undefined,
  input: Pick<PromptFillInput, 'text' | 'mode' | 'decorations'>,
  refusal?: PromptFillResult['refusal'],
): PromptFillResult {
  if (!host) return { isFilled: false, refusal: 'no_composer' }
  if (refusal !== undefined) return { isFilled: false, refusal }
  return { isFilled: host.fill(input) }
}

export function fillPromptBox(
  host: Pick<ModPromptHost, 'read'> & {
    set(text: string, cursor: number): void
    setMode?(mode: 'prompt'): void
    paint?(decorations: PromptDecoration[], text: string): void
  },
  input: Pick<PromptFillInput, 'text' | 'mode' | 'decorations'>,
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
  if (input.mode === 'replace') host.setMode?.('prompt')
  host.set(next, cursor)
  const accepted = host.read()
  validatePromptBox(accepted)
  const at = input.mode === 'replace' ? 0 : input.mode === 'append' ? box.text.length : box.cursor
  if (input.decorations !== undefined && input.text !== '' && accepted.text.startsWith(input.text, at)) {
    const runs = normalizePromptDecorations(input.decorations, input.text)
    host.paint?.(normalizePromptDecorations(runs.map(run => ({...run,start:run.start+at,end:run.end+at})), accepted.text), accepted.text)
  }
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
  attachments?: readonly PromptAttachment[]
}

export type PromptSubmitInput = PromptSubmitMetadata & {
  text: string
  /** Set by the engine on a prompt the person does not see as typed; pinned. */
  isMeta?: true
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
  for (let index = 0; index < context.length; index++) {
    if (
      !Object.hasOwn(context, index) ||
      typeof context[index] !== 'string' ||
      context[index] === ''
    )
      throw new Error('prompt.submit context must contain non-empty texts')
  }
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
  callerChain,
  admit,
}: {
  snapshot: ModSnapshot
  input: PromptSubmitInput
  core: (input: PromptSubmitInput) => Promise<ProcessUserInputBaseResult>
  signal: AbortSignal
  callerChain?: ModCallerChain
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
    ...(callerChain === undefined ? {} : { callerChain: copyModCallerChain(callerChain) }),
    restoreInput(rewritten, received) {
      const restored = { ...rewritten }
      for (const key of ['origin', 'attachments', 'turnId', 'wait', 'isMeta']) {
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
      for (const key of ['origin', 'attachments', 'turnId', 'wait', 'isMeta'] as const) {
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
