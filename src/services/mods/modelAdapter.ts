import { runForkedAgent, extractResultText, type CacheSafeParams } from '../../utils/forkedAgent.js'
import { createUserMessage } from '../../utils/messages.js'
import type { ModModelForkRequest, ModModelForkResult } from './types.js'
import { getModelMaxOutputTokens } from '../../utils/context.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import { sideQuery, type SideQueryOptions } from '../../utils/sideQuery.js'

export type ModModelCompleteRequest = {
  model: string
  prompt: string
  system?: string
  maxTokens?: number
}

type ClassifyOptions = {
  model?: string
}

type ModModelComplete = (
  request: ModModelCompleteRequest,
  signal?: AbortSignal,
) => Promise<string>

type CompletionResponse = {
  content: readonly { type: string; text?: string }[]
}

type CompleteTransport = (
  options: SideQueryOptions,
) => Promise<CompletionResponse>

function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  return Object.assign(new Error('Model request aborted'), { name: 'AbortError' })
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function createModModelComplete(
  transport: CompleteTransport = sideQuery,
  resolveModel: (model: string) => string = parseUserSpecifiedModel,
  outputLimit: (model: string) => number = model =>
    getModelMaxOutputTokens(model).upperLimit,
) {
  return async (
    request: ModModelCompleteRequest,
    signal?: AbortSignal,
  ): Promise<string> => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError('model.complete takes a request object')
    }
    if (typeof request.model !== 'string' || request.model.length === 0) {
      throw new TypeError('model must be a nonempty string')
    }
    if (typeof request.prompt !== 'string') {
      throw new TypeError('prompt must be a string')
    }
    if (request.system !== undefined && typeof request.system !== 'string') {
      throw new TypeError('system must be a string')
    }
    if (
      request.maxTokens !== undefined &&
      (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0)
    ) {
      throw new TypeError('maxTokens must be a positive integer')
    }
    const model = resolveModel(request.model)
    if (!isModelAllowed(model)) {
      throw new Error(`Model ${request.model} is not allowed`)
    }
    const maxTokens = Math.min(outputLimit(model), 64_000)
    if (request.maxTokens !== undefined && request.maxTokens > maxTokens) {
      throw new RangeError(`maxTokens cannot exceed ${maxTokens}`)
    }
    const response = await withAbort(transport({
      querySource: 'mods_model_complete',
      model,
      ...(request.system === undefined ? {} : { system: request.system }),
      messages: [{ role: 'user', content: request.prompt }],
      max_tokens: request.maxTokens ?? 1024,
      signal,
    }), signal)
    const text = response.content.flatMap(block =>
      block.type === 'text' && typeof block.text === 'string'
        ? [block.text]
        : [],
    ).join('\n')
    if (text.length === 0) {
      throw new Error('Model completion returned no text')
    }
    return text
  }
}

const CLASSIFIER_SYSTEM =
  'Choose exactly one provided label for the framed data. Reply with the label alone and no other text.'

function classifierPrompt(text: string, labels: readonly string[]): string {
  return `<labels>${JSON.stringify(labels)}</labels>\n<text>${JSON.stringify(text)}</text>`
}

export function createModModelClassify(
  complete: ModModelComplete,
  smallFastModel: () => string,
) {
  return async (
    text: string,
    labels: readonly string[],
    options?: ClassifyOptions,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    if (typeof text !== 'string') {
      throw new TypeError('text must be a string')
    }
    if (!Array.isArray(labels) || labels.length < 2) {
      throw new TypeError('labels must contain at least two labels')
    }
    if (!labels.every(label => typeof label === 'string' && label.length > 0)) {
      throw new TypeError('labels must be nonempty strings')
    }
    if (new Set(labels).size !== labels.length) {
      throw new TypeError('labels must be unique')
    }
    if (
      options !== undefined &&
      (!options || typeof options !== 'object' || Array.isArray(options))
    ) {
      throw new TypeError('options must be an object')
    }
    if (
      options?.model !== undefined &&
      (typeof options.model !== 'string' || options.model.length === 0)
    ) {
      throw new TypeError('model must be a nonempty string')
    }
    const answer = await complete({
      model: options?.model ?? smallFastModel(),
      prompt: classifierPrompt(text, labels),
      system: CLASSIFIER_SYSTEM,
      maxTokens: 1024,
    }, signal)
    return labels.includes(answer) ? answer : undefined
  }
}

export function createModModelFork(
  snapshot: () => CacheSafeParams | null,
  run: typeof runForkedAgent = runForkedAgent,
) {
  return async (request: ModModelForkRequest, signal?: AbortSignal): Promise<ModModelForkResult> => {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
      typeof request.prompt !== 'string' || Object.keys(request).some(key => key !== 'prompt'))
      throw new TypeError('model.fork takes only {prompt: string}')
    signal?.throwIfAborted()
    const cacheSafeParams = snapshot()
    if (!cacheSafeParams) return null
    const abortController = new AbortController()
    const abort = () => abortController.abort(signal?.reason)
    signal?.addEventListener('abort', abort, {once:true})
    try {
      const result = await withAbort(run({
        cacheSafeParams,
        promptMessages: [createUserMessage({content:request.prompt})],
        canUseTool: async () => ({behavior:'deny',message:'model.fork does not use tools',decisionReason:{type:'other',reason:'Tool-less fork'}}),
        querySource: 'mods_model_fork',
        forkLabel: 'mods_model_fork',
        maxTurns: 1,
        toolChoice: {type:'none'},
        skipTranscript: true,
        skipCacheWrite: true,
        overrides: {abortController, requireCanUseTool:true},
      }), signal)
      signal?.throwIfAborted()
      if (result.messages.some(message => message.type === 'assistant' && message.isApiErrorMessage)) return null
      const {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens} = result.totalUsage
      return {text:extractResultText(result.messages, ''),usage:{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}}
    } catch {
      signal?.throwIfAborted()
      return null
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }
}
