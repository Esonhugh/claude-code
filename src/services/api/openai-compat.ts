/**
 * OpenAI Responses API compatibility layer (SSE over HTTP).
 * When CLAUDE_CODE_USE_OPENAI=1, creates a duck-typed Anthropic client
 * that internally uses the OpenAI Responses API via SSE streaming.
 *
 * Supports two modes:
 *   1. ChatGPT OAuth (auth_mode=chatgpt): POST to chatgpt.com/backend-api/codex/responses
 *   2. OpenAI Platform API key (sk-...): POST to api.openai.com/v1/responses
 *      or OPENAI_BASE_URL/responses when OPENAI_BASE_URL is set.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type {
  BetaRawMessageStreamEvent,
  BetaToolUnion,
  BetaMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { logForDebugging } from '../../utils/debug.js'
import { getOpenAIAuthInfo, type OpenAIAuthInfo } from '../../utils/auth.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'

// --- Auth config ---

function loadOpenAIAuthInfo(apiKey: string): OpenAIAuthInfo {
  return getOpenAIAuthInfo() ?? { accessToken: apiKey, isChatGPT: false }
}

function normalizeOpenAIBaseURL(baseURL: string): string {
  const normalized = baseURL.replace(/\/+$/, '')
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
}

function getBaseURL(auth: OpenAIAuthInfo): string {
  if (auth.isChatGPT) return 'https://chatgpt.com/backend-api/codex'
  return normalizeOpenAIBaseURL(process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1')
}

function buildHeaders(auth: OpenAIAuthInfo): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
  }
  if (auth.isChatGPT) {
    // Browser-like headers to pass through CF
    Object.assign(headers, {
      'Accept': 'text/event-stream',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://chatgpt.com/',
      'Origin': 'https://chatgpt.com',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ...(auth.accountId && { 'chatgpt-account-id': auth.accountId }),
    })
  }
  return headers
}

// --- Model mapping: Anthropic model names → OpenAI model slugs ---

const DEFAULT_OPENAI_MODEL = 'gpt-5.5'

function mapModel(model: string): string {
  return model.startsWith('claude-') ? DEFAULT_OPENAI_MODEL : model
}

// OpenAI Responses API requires function_call IDs to start with 'fc_'
// Anthropic IDs start with 'toolu_'. We map bidirectionally.
const idMap = new Map<string, string>()

function ensureFcId(id: string): string {
  if (id.startsWith('fc_')) return id
  const mapped = idMap.get(id)
  if (mapped) return mapped
  const fcId = `fc_${id.replace(/^toolu_/, '')}`
  idMap.set(id, fcId)
  idMap.set(fcId, id)
  return fcId
}

// restoreOriginalId can be used by callers if they need to map back
export function restoreOriginalId(fcId: string): string {
  return idMap.get(fcId) || fcId
}

// --- Format Conversion: Anthropic messages → OpenAI Responses API input ---

function anthropicMessagesToResponsesInput(
  messages: BetaMessageParam[],
  _system?: string | Array<{ type: string; text?: string }>,
): any[] {
  const input: any[] = []
  // system is passed separately as `instructions`, not in input

  for (const msg of messages) {
    if (msg.role === 'user') {
      const parts: any[] = []
      if (typeof msg.content === 'string') {
        parts.push({ type: 'input_text', text: msg.content })
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'input_text', text: block.text })
          } else if (block.type === 'tool_result') {
            const b = block as any
            const output = typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((c: any) => c.text || '').join('')
                : ''
            input.push({ type: 'function_call_output', call_id: ensureFcId(b.tool_use_id || 'unknown'), output })
          }
        }
      }
      if (parts.length > 0) {
        input.push({ type: 'message', role: 'user', content: parts })
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: msg.content }] })
      } else {
        const parts: any[] = []
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'output_text', text: block.text })
          } else if (block.type === 'tool_use') {
            const b = block as any
            const fcId = ensureFcId(b.id)
            input.push({
              type: 'function_call',
              id: fcId,
              call_id: fcId,
              name: b.name,
              arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input),
            })
          }
        }
        if (parts.length > 0) {
          input.push({ type: 'message', role: 'assistant', content: parts })
        }
      }
    }
  }
  return input
}

function anthropicToolsToResponsesTools(tools?: BetaToolUnion[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.flatMap<any>((tool: any) => {
    if (
      tool.type === 'web_search_20250305' ||
      tool.type === 'web_search_20260209'
    ) {
      if (tool.blocked_domains?.length) {
        throw new Error(
          'OpenAI Responses web_search does not support blocked_domains',
        )
      }
      const allowedDomains = tool.allowed_domains?.length
        ? tool.allowed_domains
        : undefined
      return [{
        type: 'web_search',
        ...(allowedDomains && {
          filters: { allowed_domains: allowedDomains },
        }),
        ...(tool.user_location && { user_location: tool.user_location }),
      }]
    }
    if (tool.type === 'server_tool_use' || !tool.name) return []
    return [{
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    }]
  })
}

function anthropicToolChoiceToResponsesToolChoice(
  toolChoice: any,
  tools?: any[],
): any {
  if (!toolChoice) return undefined
  if (toolChoice.type === 'none' || toolChoice.type === 'auto') {
    return toolChoice.type
  }
  if (toolChoice.type === 'any') return 'required'
  if (toolChoice.type !== 'tool') return undefined
  if (
    toolChoice.name === 'web_search' &&
    tools?.some(candidate => candidate.type === 'web_search')
  ) {
    return tools.length === 1
      ? 'required'
      : {
          type: 'allowed_tools',
          mode: 'required',
          tools: [{ type: 'web_search' }],
        }
  }
  return { type: 'function', name: toolChoice.name }
}

function anthropicEffortToOpenAIReasoning(effort: unknown): {
  effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'ultra'
} | undefined {
  if (
    effort === 'none' ||
    effort === 'low' ||
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'xhigh' ||
    effort === 'ultra'
  ) {
    return { effort }
  }
  if (effort === 'max') {
    return { effort: 'ultra' }
  }
  if (effort === 'ultracode' || typeof effort === 'number') {
    return { effort: 'xhigh' }
  }
  return undefined
}

// --- SSE streaming adapter ---

function toAnthropicUsage(usage?: any) {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    server_tool_use: {
      web_search_requests: usage?.server_tool_use?.web_search_requests ?? 0,
      web_fetch_requests: usage?.server_tool_use?.web_fetch_requests ?? 0,
    },
    service_tier: usage?.service_tier ?? 'standard',
    cache_creation: {
      ephemeral_1h_input_tokens: usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      ephemeral_5m_input_tokens: usage?.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    },
  }
}

class ResponsesSSEStream implements AsyncIterable<BetaRawMessageStreamEvent> {
  private events: BetaRawMessageStreamEvent[] = []
  private resolve: (() => void) | null = null
  private done = false
  private error: Error | null = null

  push(event: BetaRawMessageStreamEvent) {
    this.events.push(event)
    if (this.resolve) { this.resolve(); this.resolve = null }
  }
  finish() { this.done = true; if (this.resolve) { this.resolve(); this.resolve = null } }
  fail(err: Error) { this.error = err; this.done = true; if (this.resolve) { this.resolve(); this.resolve = null } }

  async *[Symbol.asyncIterator](): AsyncIterator<BetaRawMessageStreamEvent> {
    while (true) {
      while (this.events.length > 0) yield this.events.shift()!
      if (this.done) { if (this.error) throw this.error; return }
      await new Promise<void>(r => { this.resolve = r })
    }
  }
  get controller(): AbortController { return new AbortController() }
}

function isRetryableOpenAIResponse(status: number): boolean {
  return status >= 500
}

async function fetchResponsesWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
  maxRetries: number,
): Promise<Response> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        ...getProxyFetchOptions(),
        method: 'POST',
        headers,
        body,
      })
      if (resp.ok) return resp

      const errText = await resp.text()
      lastError = new Error(`OpenAI API ${resp.status}: ${errText}`)
      if (!isRetryableOpenAIResponse(resp.status) || attempt >= maxRetries) {
        throw lastError
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (lastError.message.startsWith('OpenAI API ')) throw lastError
      if (attempt >= maxRetries) throw lastError
    }
  }
  throw lastError ?? new Error('OpenAI API request failed')
}

async function connectSSE(url: string, headers: Record<string, string>, payload: any, maxRetries: number): Promise<ResponsesSSEStream> {
  const stream = new ResponsesSSEStream()
  let blockIndex = 0
  let hasText = false
  let currentToolCallId: string | null = null
  let currentToolArguments = ''
  let currentWebSearchCallId: string | null = null
  let lastWebSearchCallId: string | null = null
  const webSearchCallIds = new Set<string>()
  const webSearchCallStatuses = new Map<string, string>()
  const webSearchInputsEmitted = new Set<string>()
  const webSearchCitations = new Map<string, any[]>()
  const webSearchCitationKeys = new Map<string, Set<string>>()
  let webSearchRequests = 0

  const emitWebSearchInput = (toolUseId: string, action: any) => {
    if (webSearchInputsEmitted.has(toolUseId)) return
    const queries = action?.queries
    const query = typeof action?.query === 'string' && action.query.length > 0
      ? action.query
      : Array.isArray(queries) && typeof queries[0] === 'string'
        ? queries[0]
        : undefined
    if (!query) return
    webSearchInputsEmitted.add(toolUseId)
    stream.push({ type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } } as any)
  }
  let outputTokens = 0

  const incompleteWebSearchError = () => {
    const toolUseId = [...webSearchCallIds].find(
      id => webSearchCallStatuses.get(id) !== 'completed',
    )
    if (!toolUseId) return null
    const status = webSearchCallStatuses.get(toolUseId)
    return new Error(
      status && status !== 'in_progress'
        ? `Web search ${toolUseId} ${status}`
        : `Web search ${toolUseId} did not complete`,
    )
  }

  const finishResponse = (rawUsage: any, stopReason: string) => {
    const webSearchError = incompleteWebSearchError()
    if (webSearchError) {
      stream.fail(webSearchError)
      return
    }
    if (hasText || currentToolCallId || currentWebSearchCallId) {
      stream.push({ type: 'content_block_stop', index: blockIndex } as any)
      blockIndex++
    }
    for (const toolUseId of webSearchCallIds) {
      stream.push({ type: 'content_block_start', index: blockIndex, content_block: { type: 'web_search_tool_result', tool_use_id: toolUseId, content: webSearchCitations.get(toolUseId) ?? [] } } as any)
      stream.push({ type: 'content_block_stop', index: blockIndex } as any)
      blockIndex++
    }
    const usage = toAnthropicUsage(rawUsage)
    usage.server_tool_use.web_search_requests = Math.max(
      usage.server_tool_use.web_search_requests,
      webSearchRequests,
    )
    stream.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage } as any)
    stream.push({ type: 'message_stop' } as any)
    stream.finish()
  }

  stream.push({
    type: 'message_start',
    message: {
      id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: payload.model || 'gpt-4o',
      content: [], container: null, context_management: null, stop_reason: null, stop_sequence: null,
      usage: toAnthropicUsage(),
    },
  } as any)

  const body = JSON.stringify({
    model: payload.model,
    instructions: payload.instructions || 'You are a helpful coding assistant.',
    input: payload.input,
    store: false,
    stream: true,
    ...(payload.tools && { tools: payload.tools }),
    ...(payload.tool_choice && { tool_choice: payload.tool_choice }),
    ...(payload.reasoning && { reasoning: payload.reasoning }),
  })

  try {
    const resp = await fetchResponsesWithRetry(url, headers, body, maxRetries)

    // Process SSE stream
    const reader = resp.body?.getReader()
    if (!reader) { stream.fail(new Error('No response body')); return stream }

    const decoder = new TextDecoder()
    let buffer = ''

    ;(async () => {
      try {
        while (true) {
          const { done: readerDone, value } = await reader.read()
          if (readerDone) break
          buffer += decoder.decode(value, { stream: true })

          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (data === '[DONE]') continue

            let event: any
            try { event = JSON.parse(data) } catch { continue }
            const type = event.type as string

            if (type === 'response.output_text.delta') {
              if (currentWebSearchCallId) {
                stream.push({ type: 'content_block_stop', index: blockIndex } as any)
                blockIndex++
                currentWebSearchCallId = null
              }
              if (!hasText) { hasText = true; stream.push({ type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } } as any) }
              stream.push({ type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: event.delta } } as any)
            } else if (type === 'response.output_item.added' && event.item?.type === 'web_search_call') {
              if (hasText || currentToolCallId || currentWebSearchCallId) {
                stream.push({ type: 'content_block_stop', index: blockIndex } as any)
                blockIndex++
                hasText = false
                currentToolCallId = null
                currentWebSearchCallId = null
                currentToolArguments = ''
              }
              currentWebSearchCallId = event.item.id
              lastWebSearchCallId = event.item.id
              webSearchCallIds.add(event.item.id)
              if (typeof event.item.status === 'string') {
                webSearchCallStatuses.set(event.item.id, event.item.status)
              }
              webSearchRequests++
              stream.push({ type: 'content_block_start', index: blockIndex, content_block: { type: 'server_tool_use', id: event.item.id, name: 'web_search', input: '' } } as any)
              emitWebSearchInput(event.item.id, event.item.action)
            } else if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
              if (hasText) { stream.push({ type: 'content_block_stop', index: blockIndex } as any); blockIndex++; hasText = false }
              if (currentToolCallId) { stream.push({ type: 'content_block_stop', index: blockIndex } as any); blockIndex++; currentToolArguments = '' }
              currentToolCallId = event.item.id
              const toolId = event.item.call_id || event.item.id
              stream.push({ type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: toolId, name: event.item.name || '', input: '' } } as any)
            } else if (type === 'response.function_call_arguments.delta') {
              if (!currentToolCallId) { currentToolCallId = event.item_id; stream.push({ type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: event.item_id, name: '', input: '' } } as any) }
              currentToolArguments += event.delta || ''
              stream.push({ type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: event.delta } } as any)
            } else if (type === 'response.function_call_arguments.done') {
              const doneArguments = event.arguments || ''
              if (!currentToolCallId) { currentToolCallId = event.item_id; stream.push({ type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: event.call_id || event.item_id, name: event.name || '', input: '' } } as any) }
              if (doneArguments && doneArguments !== currentToolArguments) {
                const remainingArguments = doneArguments.startsWith(currentToolArguments)
                  ? doneArguments.slice(currentToolArguments.length)
                  : doneArguments
                if (remainingArguments) {
                  stream.push({ type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: remainingArguments } } as any)
                  currentToolArguments += remainingArguments
                }
              }
            } else if (type === 'response.web_search_call.completed' || (type === 'response.output_item.done' && event.item?.type === 'web_search_call')) {
              const toolUseId = event.item_id || event.item?.id || lastWebSearchCallId
              if (toolUseId) {
                lastWebSearchCallId = toolUseId
                const status = event.item?.status ?? (type === 'response.web_search_call.completed' ? 'completed' : undefined)
                if (typeof status === 'string') {
                  webSearchCallStatuses.set(toolUseId, status)
                }
                emitWebSearchInput(toolUseId, event.item?.action)
                if (currentWebSearchCallId === toolUseId) {
                  stream.push({ type: 'content_block_stop', index: blockIndex } as any)
                  blockIndex++
                  currentWebSearchCallId = null
                }
              }
            } else if (type === 'response.output_text.annotation.added' && event.annotation?.type === 'url_citation') {
              const toolUseId = webSearchCallIds.has(event.item_id)
                ? event.item_id
                : lastWebSearchCallId
              if (toolUseId) {
                const title = event.annotation.title || event.annotation.url
                const citationKey = `${event.annotation.url}\0${title}`
                const citationKeys = webSearchCitationKeys.get(toolUseId) ?? new Set<string>()
                if (!citationKeys.has(citationKey)) {
                  citationKeys.add(citationKey)
                  webSearchCitationKeys.set(toolUseId, citationKeys)
                  const citations = webSearchCitations.get(toolUseId) ?? []
                  citations.push({
                    type: 'web_search_result',
                    url: event.annotation.url,
                    title,
                  })
                  webSearchCitations.set(toolUseId, citations)
                }
              }
            } else if (type === 'response.completed') {
              outputTokens = event.response?.usage?.output_tokens || 0
              finishResponse(
                event.response?.usage,
                currentToolCallId ? 'tool_use' : 'end_turn',
              )
              return
            } else if (type === 'response.failed' || type === 'error') {
              const msg = event.response?.error?.message || event.error?.message || event.message || 'API error'
              stream.fail(new Error(msg))
              return
            }
          }
        }
        // Stream ended without response.completed
        if (!stream['done']) {
          const webSearchError = incompleteWebSearchError()
          if (webSearchError) {
            stream.fail(webSearchError)
            return
          }
          finishResponse(
            { output_tokens: outputTokens },
            currentToolCallId ? 'tool_use' : 'end_turn',
          )
        }
      } catch (e) { stream.fail(e instanceof Error ? e : new Error(String(e))) }
    })()
  } catch (e) {
    stream.fail(e instanceof Error ? e : new Error(String(e)))
  }

  return stream
}

// --- Main: Create duck-typed Anthropic client ---

export function createOpenAICompatClient(options: {
  apiKey: string
  maxRetries: number
  timeout: number
  defaultHeaders?: Record<string, string>
}): Anthropic {
  const auth = loadOpenAIAuthInfo(options.apiKey)
  const baseURL = getBaseURL(auth)
  const responsesURL = `${baseURL}/responses`
  const headers = buildHeaders(auth)

  logForDebugging(`[OpenAI Compat] SSE client → ${responsesURL} (chatgpt=${auth.isChatGPT})`)

  const messagesProxy = {
    create(params: any): any {
      const model = mapModel(params.model || DEFAULT_OPENAI_MODEL)
      const input = anthropicMessagesToResponsesInput(params.messages, params.system)
      const tools = anthropicToolsToResponsesTools(params.tools)
      const toolChoice = anthropicToolChoiceToResponsesToolChoice(
        params.tool_choice,
        tools,
      )
      // Extract system as instructions (required by chatgpt codex backend)
      const instructions = typeof params.system === 'string'
        ? params.system
        : Array.isArray(params.system)
          ? params.system.map((b: any) => b.text || '').join('\n')
          : 'You are a helpful coding assistant.'
      const reasoning = anthropicEffortToOpenAIReasoning(params.output_config?.effort)
      const payload: any = {
        model,
        input,
        instructions,
        ...(tools && { tools }),
        ...(toolChoice && { tool_choice: toolChoice }),
        ...(reasoning && { reasoning }),
      }
      logForDebugging(`[OpenAI Compat] Responses request model=${model}`)

      if (params.stream) {
        const promise = connectSSE(responsesURL, headers, payload, options.maxRetries)
        return {
          then: (resolve: any, reject: any) => promise.then(resolve, reject),
          catch: (reject: any) => promise.catch(reject),
          withResponse: () => promise.then(data => ({ data, response: new Response(), request_id: `req_${Date.now()}` })),
        }
      }

      // Non-streaming: collect all events
      const promise = (async () => {
        const adapter = await connectSSE(responsesURL, headers, payload, options.maxRetries)
        const blocks = new Map<number, any>()
        const inputJson = new Map<number, string>()
        let stopReason: string = 'end_turn'
        let usage = toAnthropicUsage()

        for await (const event of adapter) {
          const e = event as any
          if (e.type === 'content_block_start') {
            blocks.set(e.index, { ...e.content_block })
          } else if (e.type === 'content_block_delta') {
            const block = blocks.get(e.index)
            if (e.delta?.type === 'text_delta' && block?.type === 'text') {
              block.text += e.delta.text
            } else if (e.delta?.type === 'input_json_delta') {
              inputJson.set(
                e.index,
                (inputJson.get(e.index) ?? '') + e.delta.partial_json,
              )
            }
          } else if (e.type === 'message_delta') {
            stopReason = e.delta?.stop_reason || 'end_turn'
            usage = e.usage ?? usage
          }
        }

        const content = [...blocks.entries()]
          .sort(([left], [right]) => left - right)
          .map(([index, block]) => {
            if (block.type !== 'tool_use' && block.type !== 'server_tool_use') {
              return block
            }
            return {
              ...block,
              input: safeJsonParse(inputJson.get(index) ?? ''),
            }
          })

        return {
          id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content,
          container: null, context_management: null,
          stop_reason: stopReason, stop_sequence: null,
          usage,
        }
      })()
      return {
        then: (resolve: any, reject: any) => promise.then(resolve, reject),
        catch: (reject: any) => promise.catch(reject),
        withResponse: () => promise.then(data => ({ data, response: new Response(), request_id: `req_${Date.now()}` })),
      }
    },
  }

  return { beta: { messages: messagesProxy }, messages: messagesProxy } as unknown as Anthropic
}

function safeJsonParse(str: string): unknown {
  try { return JSON.parse(str) } catch { return str }
}
