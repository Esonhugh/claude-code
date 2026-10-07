import {projectModModelText, validateModModelCompleteInput, type ModModelTextBlock} from './modelTextBlocks.js'
import {logForDebugging} from '../../utils/debug.js'
import {requiresAlwaysOnAdaptiveThinking} from '../../utils/thinking.js'
import {getAssistantMessageFromError} from '../api/errors.js'
import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { runForkedAgent, extractResultText, type CacheSafeParams } from '../../utils/forkedAgent.js'
import { createUserMessage } from '../../utils/messages.js'
import type { ModModelApiError, ModModelCompleteResult, ModModelForkRequest, ModModelForkResult, ModModelUsage } from './types.js'
import { getModelMaxOutputTokens } from '../../utils/context.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import { sideQuery, type SideQueryOptions } from '../../utils/sideQuery.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { modelSupportsEffort } from '../../utils/effort.js'
import { HttpResponseError } from '../../utils/errors.js'

export type ModModelEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ModModelCompleteRequest = {
  model: string
  prompt: string
  system?: string
  promptBlocks?: readonly ModModelTextBlock[]
  systemBlocks?: readonly ModModelTextBlock[]
  maxTokens?: number
  effort?: ModModelEffort
  timeoutMs?: number
}

export function validateModModelRequestOptions(request: ModModelCompleteRequest): void {
  if (request.effort !== undefined && !['low','medium','high','xhigh','max'].includes(request.effort))
    throw new TypeError('effort must be low, medium, high, xhigh or max')
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0))
    throw new TypeError('timeoutMs must be a positive integer')
}

type ClassifyOptions = {
  model?: string
}

type ModModelComplete = (
  request: ModModelCompleteRequest,
  signal?: AbortSignal,
) => Promise<ModModelCompleteResult>

type CompletionResponse = {
  content: readonly { type: string; text?: string }[]
  usage?: Partial<ModModelUsage>
}

type CompleteTransport = (
  options: SideQueryOptions,
) => Promise<CompletionResponse>

function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  return Object.assign(new Error('Model request aborted'), { name: 'AbortError' })
}

function modelUsage(usage?: Partial<ModModelUsage>): ModModelUsage {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
  }
}

function completeApiFailure(error: unknown, usage: ModModelUsage, model: string): ModModelCompleteResult {
  const failure = getAssistantMessageFromError(error, model)
  const status = error instanceof APIError || error instanceof HttpResponseError ? error.status ?? null : null
  let kind = (failure.error ?? 'unknown') as ModModelApiError
  if (error instanceof APIConnectionError) kind = 'server_error'
  else if (status === 404 && ['unknown','invalid_request'].includes(kind)) kind = 'model_not_found'
  else if (status === 429 && kind === 'unknown') kind = 'rate_limit'
  else if (status !== null && status >= 500 && ['unknown','overloaded'].includes(kind)) kind = 'server_error'
  logForDebugging(`[Mods] model.complete: ${model}; api-error ${kind}, HTTP ${status ?? 'no status'}`)
  return {isAnswered:false,reason:'api-error',status,error:kind,usage}
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return await new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(abortError(signal)) }
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
  ): Promise<ModModelCompleteResult> => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError('model.complete takes a request object')
    }
    validateModModelRequestOptions(request)
    if (typeof request.model !== 'string' || request.model.length === 0) {
      throw new TypeError('model must be a nonempty string')
    }
    if (typeof request.prompt !== 'string') {
      throw new TypeError('prompt must be a string')
    }
    if (request.system && typeof request.system !== 'string') {
      throw new TypeError('system must be a string')
    }
    if (
      request.maxTokens !== undefined &&
      (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0)
    ) {
      throw new TypeError('maxTokens must be a positive integer')
    }
    validateModModelCompleteInput(request)
    const model = resolveModel(request.model)
    if (!isModelAllowed(model)) {
      throw new Error(`Model ${request.model} is not allowed`)
    }
    const maxTokens = Math.min(outputLimit(model), 64_000)
    if (request.maxTokens !== undefined && request.maxTokens > maxTokens) {
      throw new RangeError(`maxTokens cannot exceed ${maxTokens}`)
    }
    const combined = request.timeoutMs === undefined
      ? { signal, cleanup: () => {} }
      : createCombinedAbortSignal(signal, {timeoutMs:Math.min(request.timeoutMs,2147483647)})
    signal = combined.signal
    try {
      if (signal?.aborted) return { isAnswered: false, reason: 'aborted', usage: modelUsage() }
      const user = projectModModelText(request.prompt, request.promptBlocks)
      const rules = projectModModelText(typeof request.system === 'string' ? request.system : '', request.systemBlocks)
      const wellFormed = (text: string) => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\ufffd')
      const safeUser = typeof user === 'string' ? wellFormed(user) : user.map(block => ({...block,text:wellFormed(block.text)}))
      const safeRules = typeof rules === 'string' ? wellFormed(rules) : rules.map(block => ({...block,text:wellFormed(block.text)}))
      const thinkingRequired = requiresAlwaysOnAdaptiveThinking(model)
      logForDebugging(`[Mods] model.complete: ${model}; prompt ${request.prompt.length} chars / ${request.promptBlocks?.length ?? 0} blocks, system ${typeof request.system === 'string' ? request.system.length : 0} chars / ${request.systemBlocks?.length ?? 0} blocks`)
      let response: CompletionResponse
      try {
        response = await withAbort(transport({
          querySource: 'hook_prompt',
          model,
          ...(safeRules.length > 0 ? {system: safeRules} : {}),
          messages: [{ role: 'user', content: safeUser }],
          max_tokens: Math.min((request.maxTokens ?? 1024) + (thinkingRequired ? 2048 : 0), maxTokens),
          ...(thinkingRequired ? {} : {thinking: false}),
          skipSystemPromptPrefix: true,
          dropCacheControlWhenCachingDisabled: true,
          ...(request.effort !== undefined && modelSupportsEffort(model) ? {effort:request.effort} : {}),
          signal,
        }), signal)
      } catch (error) {
        if (signal?.aborted) return { isAnswered: false, reason: 'aborted', usage: modelUsage() }
        return completeApiFailure(error, modelUsage(), model)
      }
      if (signal?.aborted) return { isAnswered: false, reason: 'aborted', usage: modelUsage() }
      const text = response.content.flatMap(block =>
        block.type === 'text' && typeof block.text === 'string'
          ? [block.text]
          : [],
      ).join('')
      logForDebugging(`[Mods] model.complete: ${model}; ${text.length === 0 ? 'empty-reply' : 'answered'}, ${text.length} chars; usage ${Object.values(modelUsage(response.usage)).join('/')} `)
      if (text.length === 0) {
        return { isAnswered: false, reason: 'empty-reply', usage: modelUsage(response.usage) }
      }
      return { isAnswered: true, text, usage: modelUsage(response.usage) }
    } finally { combined.cleanup() }
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
    if (answer.isAnswered === false) {
      throw new Error(`model.classify failed: ${answer.reason}${answer.reason === 'api-error' ? ` (${answer.error}, status ${answer.status})` : ''}`)
    }
    return labels.includes(answer.text) ? answer.text : undefined
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
