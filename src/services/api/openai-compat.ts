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
import { randomUUID } from 'crypto'
import WebSocket from 'ws'
import type {
  BetaRawMessageStreamEvent,
  BetaToolUnion,
  BetaMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { logForDebugging } from '../../utils/debug.js'
import { getOpenAIAuthInfo, type OpenAIAuthInfo } from '../../utils/auth.js'
import {
  getProxyFetchOptions,
  getWebSocketProxyAgent,
} from '../../utils/proxy.js'
import { getWebSocketTLSOptions } from '../../utils/mtls.js'
import type { OpenAITurnScope } from './openai-turn-scope.js'

// --- Auth config ---

function loadOpenAIAuthInfo(apiKey: string): OpenAIAuthInfo {
  return getOpenAIAuthInfo() ?? { accessToken: apiKey, isChatGPT: false }
}

function isOpenAITunnelEnabled(): boolean {
  return Boolean(process.env.CLAUDE_CODE_OPENAI_UNIX_SOCKET)
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
  effort:
    | 'none'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max'
    | 'ultra'
} | undefined {
  if (
    effort === 'none' ||
    effort === 'minimal' ||
    effort === 'low' ||
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'xhigh' ||
    effort === 'max' ||
    effort === 'ultra'
  ) {
    return { effort }
  }
  if (effort === 'ultracode' || typeof effort === 'number') {
    return { effort: 'xhigh' }
  }
  return undefined
}

// --- SSE streaming adapter ---

function toAnthropicUsage(usage?: any) {
  const inputTokensDetails = usage?.input_tokens_details
  const hasOpenAIInputTokenDetails = inputTokensDetails != null
  const cacheReadInputTokens = hasOpenAIInputTokenDetails
    ? (inputTokensDetails.cached_tokens ?? 0)
    : (usage?.cache_read_input_tokens ?? 0)
  const cacheCreationInputTokens = hasOpenAIInputTokenDetails
    ? (inputTokensDetails.cache_write_tokens ?? 0)
    : (usage?.cache_creation_input_tokens ?? 0)
  // OpenAI input_tokens includes cached/written tokens, while Anthropic usage
  // represents these as separate additive buckets.
  const inputTokens = hasOpenAIInputTokenDetails
    ? Math.max(
        0,
        (usage?.input_tokens ?? 0) -
          cacheReadInputTokens -
          cacheCreationInputTokens,
      )
    : (usage?.input_tokens ?? 0)

  return {
    input_tokens: inputTokens,
    output_tokens: usage?.output_tokens ?? 0,
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
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

  constructor(
    readonly controller: AbortController,
    private readonly onDone: () => void,
  ) {}

  push(event: BetaRawMessageStreamEvent) {
    this.events.push(event)
    if (this.resolve) { this.resolve(); this.resolve = null }
  }
  finish() {
    this.done = true
    this.onDone()
    if (this.resolve) { this.resolve(); this.resolve = null }
  }
  fail(err: Error) {
    this.error = err
    this.done = true
    this.onDone()
    if (this.resolve) { this.resolve(); this.resolve = null }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<BetaRawMessageStreamEvent> {
    while (true) {
      while (this.events.length > 0) yield this.events.shift()!
      if (this.done) { if (this.error) throw this.error; return }
      await new Promise<void>(r => { this.resolve = r })
    }
  }
}

function isRetryableOpenAIResponse(status: number): boolean {
  return status >= 500
}

type OpenAIWebSocketFactory = (
  url: string,
  options: WebSocket.ClientOptions,
) => WebSocket

async function connectResponsesWebSocket(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
  turnScope: OpenAITurnScope,
  webSocketFactory: OpenAIWebSocketFactory,
): Promise<Response> {
  const wsURL = new URL(url)
  wsURL.protocol = wsURL.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsHeaders = {
    ...headers,
    'OpenAI-Beta': 'responses_websockets=2026-02-06',
  }
  const tlsOptions = getWebSocketTLSOptions()
  const socket = webSocketFactory(wsURL.toString(), {
    headers: wsHeaders,
    agent: getWebSocketProxyAgent(wsURL.toString()),
    ...tlsOptions,
  })

  return await new Promise<Response>((resolve, reject) => {
    let responseStarted = false
    let terminal = false
    let failed = false
    let streamController: ReadableStreamDefaultController<Uint8Array>
    const encoder = new TextEncoder()
    const fail = (error: Error) => {
      if (terminal || failed) return
      failed = true
      signal.removeEventListener('abort', onAbort)
      if (!responseStarted) {
        socket.close()
        reject(error)
        return
      }
      streamController.error(error)
    }
    const onAbort = () =>
      fail(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Request aborted'),
      )
    signal.addEventListener('abort', onAbort, { once: true })

    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
      cancel() {
        socket.close()
      },
    })

    socket.once('unexpected-response', (_request, response) => {
      fail(new Error(`OpenAI Responses WebSocket ${response.statusCode}`))
    })
    socket.once('upgrade', response => {
      const value = response.headers['x-codex-turn-state']
      turnScope.setTurnStateIfAbsent(Array.isArray(value) ? value[0] : value)
    })
    socket.on('error', error => fail(error))
    socket.once('close', () => {
      if (!terminal) {
        fail(new Error('WebSocket closed before response.completed'))
      }
    })
    socket.once('open', () => {
      const parsedBody = JSON.parse(body) as Record<string, unknown>
      socket.send(
        JSON.stringify({
          type: 'response.create',
          ...parsedBody,
          client_metadata: {
            session_id: turnScope.identity.sessionId,
            thread_id: turnScope.identity.threadId,
            turn_id: turnScope.turnId,
            ...(turnScope.getTurnState() && {
              'x-codex-turn-state': turnScope.getTurnState(),
            }),
          },
        }),
      )
    })
    socket.on('message', data => {
      const text = data.toString()
      let event: { type?: string } | undefined
      try {
        event = JSON.parse(text)
      } catch {
        return
      }
      if (!responseStarted) {
        responseStarted = true
        resolve(
          new Response(responseBody, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        )
      }
      streamController.enqueue(encoder.encode(`data: ${text}\n\n`))
      terminal =
        event?.type === 'response.completed' ||
        event?.type === 'response.incomplete' ||
        event?.type === 'response.failed' ||
        event?.type === 'error'
      if (terminal) {
        signal.removeEventListener('abort', onAbort)
        streamController.close()
        socket.close()
      }
    })
  })
}

async function fetchResponsesWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
  maxRetries: number,
  signal: AbortSignal,
  turnScope?: OpenAITurnScope,
  webSocketFactory?: OpenAIWebSocketFactory,
): Promise<Response> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const createRequestHeaders = () => ({
        ...headers,
        'x-client-request-id': randomUUID(),
        ...(turnScope?.getTurnState() && {
          'x-codex-turn-state': turnScope.getTurnState()!,
        }),
      })
      const requestHeaders = createRequestHeaders()
      let resp: Response
      if (
        webSocketFactory &&
        turnScope?.canUseWebSocket() &&
        attempt === 0
      ) {
        try {
          resp = await connectResponsesWebSocket(
            url,
            requestHeaders,
            body,
            signal,
            turnScope,
            webSocketFactory,
          )
        } catch (error) {
          if (signal.aborted) throw error
          turnScope.disableWebSocket()
          logForDebugging(
            `[OpenAI Compat] WebSocket unavailable, falling back to SSE: ${error instanceof Error ? error.message : String(error)}`,
          )
          resp = await fetch(url, {
            ...getProxyFetchOptions({ forOpenAIAPI: true }),
            method: 'POST',
            headers: createRequestHeaders(),
            body,
            signal,
          })
        }
      } else {
        resp = await fetch(url, {
          ...getProxyFetchOptions({ forOpenAIAPI: true }),
          method: 'POST',
          headers: requestHeaders,
          body,
          signal,
        })
      }
      turnScope?.setTurnStateIfAbsent(resp.headers.get('x-codex-turn-state'))
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

async function connectSSE(
  url: string,
  headers: Record<string, string>,
  payload: any,
  maxRetries: number,
  controller: AbortController,
  onDone?: () => void,
  turnScope?: OpenAITurnScope,
  webSocketFactory?: OpenAIWebSocketFactory,
): Promise<ResponsesSSEStream> {
  const stream = new ResponsesSSEStream(controller, onDone ?? (() => {}))
  let blockIndex = 0
  let hasThinking = false
  let reasoningText = ''
  let reasoningTextSource: 'summary' | 'raw' | null = null
  let reasoningTextKey: string | null = null
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

  const closeCurrentBlock = () => {
    if (!hasThinking && !hasText && !currentToolCallId && !currentWebSearchCallId) {
      return
    }
    stream.push({ type: 'content_block_stop', index: blockIndex } as any)
    blockIndex++
    hasThinking = false
    reasoningText = ''
    reasoningTextSource = null
    reasoningTextKey = null
    hasText = false
    currentToolCallId = null
    currentWebSearchCallId = null
    currentToolArguments = ''
  }

  const finishResponse = (rawUsage: any, stopReason: string) => {
    const webSearchError = incompleteWebSearchError()
    if (webSearchError) {
      stream.fail(webSearchError)
      return
    }
    closeCurrentBlock()
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
    ...(payload.service_tier && { service_tier: payload.service_tier }),
    ...(payload.prompt_cache_key && {
      prompt_cache_key: payload.prompt_cache_key,
    }),
  })

  try {
    const resp = await fetchResponsesWithRetry(
      url,
      headers,
      body,
      maxRetries,
      controller.signal,
      turnScope,
      webSocketFactory,
    )

    // Process SSE stream
    const reader = resp.body?.getReader()
    if (!reader) { stream.fail(new Error('No response body')); return stream }

    const decoder = new TextDecoder()
    let buffer = ''

    ;(async () => {
      try {
        while (true) {
          const { done: readerDone, value } = await reader.read()
          if (readerDone) {
            buffer += decoder.decode()
            if (buffer) buffer += '\n'
          } else {
            buffer += decoder.decode(value, { stream: true })
          }

          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (data === '[DONE]') continue

            let event: any
            try { event = JSON.parse(data) } catch { continue }
            const type = event.type as string
            if (type === 'response.metadata') {
              const metadataHeaders = event.headers
              if (metadataHeaders && typeof metadataHeaders === 'object') {
                const turnStateEntry = Object.entries(metadataHeaders).find(
                  ([name]) => name.toLowerCase() === 'x-codex-turn-state',
                )
                if (typeof turnStateEntry?.[1] === 'string') {
                  turnScope?.setTurnStateIfAbsent(turnStateEntry[1])
                }
              }
            }

            if (
              type === 'response.reasoning_summary_text.delta' ||
              type === 'response.reasoning_text.delta'
            ) {
              const source = type === 'response.reasoning_text.delta'
                ? 'raw'
                : 'summary'
              const key = `${source}:${event.item_id ?? ''}:${event.summary_index ?? event.content_index ?? ''}`
              const delta = typeof event.delta === 'string' ? event.delta : ''
              if (!hasThinking && (hasText || currentToolCallId || currentWebSearchCallId)) {
                closeCurrentBlock()
              } else if (reasoningTextKey && reasoningTextKey !== key) {
                closeCurrentBlock()
              }
              if (!hasThinking) {
                hasThinking = true
                reasoningTextSource = source
                reasoningTextKey = key
                stream.push({
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: { type: 'thinking', thinking: '', signature: '' },
                } as any)
              }
              reasoningText += delta
              if (delta) {
                stream.push({
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'thinking_delta', thinking: delta },
                } as any)
              }
            } else if (
              type === 'response.reasoning_summary_text.done' ||
              type === 'response.reasoning_text.done'
            ) {
              const source = type === 'response.reasoning_text.done'
                ? 'raw'
                : 'summary'
              const key = `${source}:${event.item_id ?? ''}:${event.summary_index ?? event.content_index ?? ''}`
              const text = typeof event.text === 'string' ? event.text : ''
              if (reasoningTextKey && reasoningTextKey !== key) {
                closeCurrentBlock()
              }
              if (!reasoningTextSource && text) {
                if (hasText || currentToolCallId || currentWebSearchCallId) {
                  closeCurrentBlock()
                }
                hasThinking = true
                reasoningTextSource = source
                reasoningTextKey = key
                stream.push({
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: {
                    type: 'thinking',
                    thinking: '',
                    signature: '',
                  },
                } as any)
              }
              if (reasoningTextSource === source && text !== reasoningText) {
                const remainingText = text.startsWith(reasoningText)
                  ? text.slice(reasoningText.length)
                  : text
                if (remainingText) {
                  stream.push({
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: {
                      type: 'thinking_delta',
                      thinking: remainingText,
                    },
                  } as any)
                  reasoningText += remainingText
                }
              }
              if (hasThinking) {
                closeCurrentBlock()
              }
            } else if (type === 'response.output_text.delta') {
              if (hasThinking || currentToolCallId || currentWebSearchCallId) {
                closeCurrentBlock()
              }
              if (!hasText) { hasText = true; stream.push({ type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } } as any) }
              stream.push({ type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: event.delta } } as any)
            } else if (type === 'response.output_item.added' && event.item?.type === 'web_search_call') {
              closeCurrentBlock()
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
              closeCurrentBlock()
              currentToolCallId = event.item.id
              const toolId = event.item.call_id || event.item.id
              stream.push({ type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: toolId, name: event.item.name || '', input: '' } } as any)
            } else if (type === 'response.function_call_arguments.delta') {
              if (!currentToolCallId) {
                closeCurrentBlock()
                currentToolCallId = event.item_id
                stream.push({ type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: event.item_id, name: '', input: '' } } as any)
              }
              currentToolArguments += event.delta || ''
              stream.push({ type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: event.delta } } as any)
            } else if (type === 'response.function_call_arguments.done') {
              const doneArguments = event.arguments || ''
              if (!currentToolCallId) {
                closeCurrentBlock()
                currentToolCallId = event.item_id
                stream.push({ type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: event.call_id || event.item_id, name: event.name || '', input: '' } } as any)
              }
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
                  closeCurrentBlock()
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
            } else if (
              type === 'response.incomplete' ||
              type === 'response.failed' ||
              type === 'error'
            ) {
              const msg =
                event.response?.incomplete_details?.reason ||
                event.response?.error?.message ||
                event.error?.message ||
                event.message ||
                'API error'
              stream.fail(new Error(msg))
              return
            }
          }
          if (readerDone) break
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
  promptCacheKey?: string
  turnScope?: OpenAITurnScope
  webSocketFactory?: OpenAIWebSocketFactory
  enableWebSocket?: boolean
}): Anthropic {
  const tunnel = isOpenAITunnelEnabled()
  const auth = loadOpenAIAuthInfo(options.apiKey)
  const webSocketFactory =
    options.webSocketFactory ??
    (options.enableWebSocket &&
    auth.isChatGPT &&
    !tunnel &&
    typeof Bun === 'undefined'
      ? ((url, wsOptions) => new WebSocket(url, wsOptions))
      : undefined)
  const baseURL = tunnel ? 'http://localhost' : getBaseURL(auth)
  const responsesURL = `${baseURL}/responses`
  const headers: Record<string, string> = {}
  new Headers(options.defaultHeaders).forEach((value, name) => {
    headers[name] = value
  })
  for (const [name, value] of Object.entries(
    tunnel
      ? { 'Content-Type': 'application/json' }
      : buildHeaders(auth),
  )) {
    headers[name.toLowerCase()] = value
  }
  const identity = options.turnScope?.identity
  if (identity) {
    headers['session-id'] = identity.sessionId
    headers['thread-id'] = identity.threadId
  } else if (options.promptCacheKey) {
    headers['session-id'] = options.promptCacheKey
    headers['thread-id'] = options.promptCacheKey
  }

  logForDebugging(
    `[OpenAI Compat] SSE client → ${responsesURL} (chatgpt=${auth.isChatGPT}, tunnel=${tunnel})`,
  )

  const messagesProxy = {
    async compact(params: any, requestOptions?: { signal?: AbortSignal }): Promise<{
      item: { type: 'compaction'; encrypted_content: string; id?: string }
      usage: ReturnType<typeof toAnthropicUsage>
    }> {
      const input = anthropicMessagesToResponsesInput(
        params.messages ?? [],
        params.system,
      )
      if (
        params.openai_compaction?.type === 'compaction' &&
        typeof params.openai_compaction.encrypted_content === 'string'
      ) {
        input.unshift(params.openai_compaction)
      }
      input.push({ type: 'compaction_trigger' })
      const body = JSON.stringify({
        model: mapModel(params.model || DEFAULT_OPENAI_MODEL),
        instructions: params.instructions || 'You are a helpful coding assistant.',
        input,
        store: false,
        stream: true,
        ...(options.promptCacheKey && {
          prompt_cache_key: options.promptCacheKey,
        }),
      })
      const controller = new AbortController()
      if (requestOptions?.signal?.aborted) {
        controller.abort(requestOptions.signal.reason)
      } else {
        requestOptions?.signal?.addEventListener(
          'abort',
          () => controller.abort(requestOptions.signal?.reason),
          { once: true },
        )
      }
      const response = await fetchResponsesWithRetry(
        responsesURL,
        headers,
        body,
        options.maxRetries,
        controller.signal,
        options.turnScope,
        webSocketFactory,
      )
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Remote compaction returned no response body')
      const decoder = new TextDecoder()
      let buffer = ''
      let completed = false
      let usage = toAnthropicUsage()
      const items: Array<{
        type: 'compaction'
        encrypted_content: string
        id?: string
      }> = []
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (!data || data === '[DONE]') continue
          let event: any
          try { event = JSON.parse(data) } catch { continue }
          if (event.type === 'response.metadata') {
            const metadataHeaders = event.headers
            if (metadataHeaders && typeof metadataHeaders === 'object') {
              const turnState = Object.entries(metadataHeaders).find(
                ([name]) => name.toLowerCase() === 'x-codex-turn-state',
              )?.[1]
              if (typeof turnState === 'string') {
                options.turnScope?.setTurnStateIfAbsent(turnState)
              }
            }
          }
          if (
            event.type === 'response.output_item.done' &&
            event.item?.type === 'compaction' &&
            typeof event.item.encrypted_content === 'string'
          ) {
            items.push(event.item)
          } else if (event.type === 'response.completed') {
            completed = true
            usage = toAnthropicUsage(event.response?.usage)
          } else if (
            event.type === 'response.failed' ||
            event.type === 'response.incomplete' ||
            event.type === 'error'
          ) {
            throw new Error(
              event.response?.error?.message ||
                event.error?.message ||
                event.message ||
                'Remote compaction failed',
            )
          }
        }
        if (done) break
      }
      if (!completed) {
        throw new Error('Remote compaction ended before response.completed')
      }
      if (items.length !== 1) {
        throw new Error(
          `Remote compaction returned ${items.length} compaction items; expected exactly one`,
        )
      }
      return { item: items[0]!, usage }
    },
    async countTokens(params: any): Promise<{ input_tokens: number }> {
      const input = anthropicMessagesToResponsesInput(
        params.messages ?? [],
        params.system,
      )
      const tools = anthropicToolsToResponsesTools(params.tools)
      const serialized = JSON.stringify({
        input,
        ...(tools && { tools }),
        ...(params.system && { system: params.system }),
      })
      return { input_tokens: Math.max(1, Math.ceil(serialized.length / 4)) }
    },
    create(params: any, requestOptions?: { signal?: AbortSignal }): any {
      const model = mapModel(params.model || DEFAULT_OPENAI_MODEL)
      const input = anthropicMessagesToResponsesInput(params.messages, params.system)
      if (
        params.openai_compaction?.type === 'compaction' &&
        typeof params.openai_compaction.encrypted_content === 'string'
      ) {
        input.unshift(params.openai_compaction)
      }
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
        ...(params.speed === 'fast' && { service_tier: 'priority' }),
        ...(options.promptCacheKey && {
          prompt_cache_key: options.promptCacheKey,
        }),
      }
      logForDebugging(
        `[OpenAI Compat] Responses request model=${model} service_tier=${payload.service_tier ?? 'standard'}`,
      )

      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(new Error(`Request timed out after ${options.timeout}ms`)),
        options.timeout,
      )
      timeout.unref()
      if (requestOptions?.signal?.aborted) {
        controller.abort(requestOptions.signal.reason)
      } else {
        requestOptions?.signal?.addEventListener(
          'abort',
          () => controller.abort(requestOptions.signal?.reason),
          { once: true },
        )
      }

      if (params.stream) {
        const promise = connectSSE(
          responsesURL,
          headers,
          payload,
          options.maxRetries,
          controller,
          () => clearTimeout(timeout),
          options.turnScope,
          webSocketFactory,
        )
        return {
          then: (resolve: any, reject: any) => promise.then(resolve, reject),
          catch: (reject: any) => promise.catch(reject),
          withResponse: () => promise.then(data => ({ data, response: new Response(), request_id: `req_${Date.now()}` })),
        }
      }

      // Non-streaming: collect all events
      const promise = (async () => {
        const adapter = await connectSSE(
          responsesURL,
          headers,
          payload,
          options.maxRetries,
          controller,
          undefined,
          options.turnScope,
          webSocketFactory,
        )
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
            } else if (
              e.delta?.type === 'thinking_delta' &&
              block?.type === 'thinking'
            ) {
              block.thinking += e.delta.thinking
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
      })().finally(() => clearTimeout(timeout))
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
