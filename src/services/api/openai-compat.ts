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
  return model
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
  return tools
    .filter((t: any) => t.type !== 'server_tool_use' && t.name)
    .map((t: any) => ({
      type: 'function',
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    }))
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
  let outputTokens = 0

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
              if (!hasText) { hasText = true; stream.push({ type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } } as any) }
              stream.push({ type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: event.delta } } as any)
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
            } else if (type === 'response.completed') {
              if (hasText || currentToolCallId) stream.push({ type: 'content_block_stop', index: blockIndex } as any)
              outputTokens = event.response?.usage?.output_tokens || 0
              const stopReason = currentToolCallId ? 'tool_use' : 'end_turn'
              stream.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: toAnthropicUsage(event.response?.usage) } as any)
              stream.push({ type: 'message_stop' } as any)
              stream.finish()
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
          if (hasText || currentToolCallId) stream.push({ type: 'content_block_stop', index: blockIndex } as any)
          stream.push({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: toAnthropicUsage({ output_tokens: outputTokens }) } as any)
          stream.push({ type: 'message_stop' } as any)
          stream.finish()
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
      // Extract system as instructions (required by chatgpt codex backend)
      const instructions = typeof params.system === 'string'
        ? params.system
        : Array.isArray(params.system)
          ? params.system.map((b: any) => b.text || '').join('\n')
          : 'You are a helpful coding assistant.'
      const reasoning = anthropicEffortToOpenAIReasoning(params.output_config?.effort)
      const payload: any = { model, input, instructions, ...(tools && { tools }), ...(reasoning && { reasoning }) }
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
        let text = ''
        const toolCalls: any[] = []
        let currentToolArgs = ''
        let currentToolName = ''
        let currentToolId = ''
        let stopReason: string = 'end_turn'
        let inputTokens = 0
        let outTokens = 0

        for await (const event of adapter) {
          const e = event as any
          if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
            if (currentToolId) { toolCalls.push({ type: 'tool_use', id: currentToolId, name: currentToolName, input: safeJsonParse(currentToolArgs) }) }
            currentToolId = e.content_block.id; currentToolName = e.content_block.name; currentToolArgs = ''
          } else if (e.type === 'content_block_delta') {
            if (e.delta?.type === 'text_delta') text += e.delta.text
            else if (e.delta?.type === 'input_json_delta') currentToolArgs += e.delta.partial_json
          } else if (e.type === 'message_delta') {
            stopReason = e.delta?.stop_reason || 'end_turn'
            inputTokens = e.usage?.input_tokens || 0
            outTokens = e.usage?.output_tokens || 0
          }
        }
        if (currentToolId) { toolCalls.push({ type: 'tool_use', id: currentToolId, name: currentToolName, input: safeJsonParse(currentToolArgs) }) }

        const content: any[] = []
        if (text) content.push({ type: 'text', text })
        content.push(...toolCalls)

        return {
          id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content,
          container: null, context_management: null,
          stop_reason: stopReason, stop_sequence: null,
          usage: toAnthropicUsage({ input_tokens: inputTokens, output_tokens: outTokens }),
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
