#!/usr/bin/env node
import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalFetch = globalThis.fetch
const originalOpenAIBaseURL = process.env.OPENAI_BASE_URL

try {
  const { getOpenAIAuthInfo } = await import('../../utils/auth.js')
  const { createOpenAICompatClient } = await import('./openai-compat.js')

  getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'sk-test-api-key',
    isChatGPT: false,
  })

  process.env.OPENAI_BASE_URL = 'https://gateway.example.test/openai/v1'

  const requests: Array<{
    url: string
    authorization: string | null
    body: any
  }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    requests.push({
      url: String(input),
      authorization: headers.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return new Response(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    )
  }) as unknown as typeof fetch

  const client = createOpenAICompatClient({
    apiKey: 'sk-test-api-key',
    maxRetries: 0,
    timeout: 1000,
  })

  await client.beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  })

  assert.equal(
    requests[0]!.url,
    'https://gateway.example.test/openai/v1/responses',
  )
  assert.equal(requests[0]!.authorization, 'Bearer sk-test-api-key')
  assert.equal(requests[0]!.body.reasoning, undefined)

  requests.length = 0
  process.env.OPENAI_BASE_URL = 'https://gateway.example.test/'

  const rootURLClient = createOpenAICompatClient({
    apiKey: 'sk-test-api-key',
    maxRetries: 0,
    timeout: 1000,
  })

  await rootURLClient.beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  })

  assert.equal(requests[0]!.url, 'https://gateway.example.test/v1/responses')

  requests.length = 0
  await rootURLClient.beta.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  })

  assert.equal(requests[0]!.body.model, 'gpt-5.5')

  requests.length = 0
  await rootURLClient.beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'search' }],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        allowed_domains: ['example.com'],
        user_location: {
          type: 'approximate',
          country: 'US',
          region: 'California',
          city: 'San Francisco',
          timezone: 'America/Los_Angeles',
        },
        max_uses: 8,
      },
    ],
    tool_choice: { type: 'tool', name: 'web_search' },
  } as any)

  assert.deepEqual(requests[0]!.body.tools, [
    {
      type: 'web_search',
      filters: { allowed_domains: ['example.com'] },
      user_location: {
        type: 'approximate',
        country: 'US',
        region: 'California',
        city: 'San Francisco',
        timezone: 'America/Los_Angeles',
      },
    },
  ])
  assert.equal(requests[0]!.body.tool_choice, 'required')

  requests.length = 0
  await rootURLClient.beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'search' }],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        allowed_domains: [],
        blocked_domains: [],
        max_uses: 8,
      },
    ],
  } as any)

  assert.deepEqual(requests[0]!.body.tools, [{ type: 'web_search' }])

  assert.throws(
    () => rootURLClient.beta.messages.create({
      model: 'gpt-5.5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'search' }],
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        blocked_domains: ['blocked.example'],
        max_uses: 8,
      }],
    } as any),
    /does not support blocked_domains/,
  )

  requests.length = 0
  await rootURLClient.beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'search' }],
    tools: [
      { type: 'web_search_20250305', name: 'web_search' },
      {
        type: 'custom',
        name: 'Bash',
        description: 'Run shell command',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'web_search' },
  } as any)

  assert.deepEqual(requests[0]!.body.tool_choice, {
    type: 'allowed_tools',
    mode: 'required',
    tools: [{ type: 'web_search' }],
  })

  requests.length = 0
  await rootURLClient.beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    output_config: { effort: 'medium' },
  } as any)

  assert.deepEqual(requests[0]!.body.reasoning, { effort: 'medium' })

  requests.length = 0
  await rootURLClient.beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    output_config: { effort: 'max' },
  } as any)

  assert.deepEqual(requests[0]!.body.reasoning, { effort: 'ultra' })

  requests.length = 0
  await rootURLClient.beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    output_config: { effort: 'ultra' },
  } as any)

  assert.deepEqual(requests[0]!.body.reasoning, { effort: 'ultra' })

  const {
    EFFORT_LEVELS,
    parseEffortValue,
    resolveAppliedEffort,
    toPersistableEffort,
  } = await import('../../utils/effort.js')
  assert.equal(EFFORT_LEVELS.includes('ultra' as any), true)
  assert.equal(parseEffortValue('ultra'), 'ultra')
  assert.equal(toPersistableEffort('ultra' as any), 'ultra')

  const originalUseOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  assert.equal(resolveAppliedEffort('gpt-5.5', 'none'), 'none')
  assert.equal(resolveAppliedEffort('gpt-5.5', 'xhigh'), 'xhigh')
  assert.equal(resolveAppliedEffort('gpt-5.5', 'max'), 'ultra')
  assert.equal(resolveAppliedEffort('gpt-5.5', 'ultra'), 'ultra')
  assert.equal(resolveAppliedEffort('gpt-5.5', 'ultracode'), 'xhigh')
  const appliedUltra = resolveAppliedEffort('gpt-5.5', 'ultra')

  requests.length = 0
  await rootURLClient.beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    output_config: { effort: appliedUltra },
  } as any)

  assert.deepEqual(requests[0]!.body.reasoning, { effort: 'ultra' })
  if (originalUseOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalUseOpenAI

  requests.length = 0
  await rootURLClient.beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    output_config: { effort: 'ultracode' },
  } as any)

  assert.deepEqual(requests[0]!.body.reasoning, { effort: 'xhigh' })

  requests.length = 0
  await rootURLClient.beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    output_config: { effort: 'none' },
  } as any)

  assert.deepEqual(requests[0]!.body.reasoning, { effort: 'none' })

  requests.length = 0
  let attempts = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    attempts++
    const headers = new Headers(init?.headers)
    requests.push({
      url: String(input),
      authorization: headers.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    if (attempts === 1) {
      return new Response(
        JSON.stringify({ error: { message: 'Our servers are currently overloaded. Please try again later.' } }),
        { status: 529, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    )
  }) as unknown as typeof fetch

  const retryClient = createOpenAICompatClient({
    apiKey: 'sk-test-api-key',
    maxRetries: 1,
    timeout: 1000,
  })

  await retryClient.beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  })

  assert.equal(attempts, 2)
  assert.equal(requests.length, 2)

  requests.length = 0
  attempts = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    attempts++
    const headers = new Headers(init?.headers)
    requests.push({
      url: String(input),
      authorization: headers.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return new Response(
      JSON.stringify({ error: { message: 'rate limited' } }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  await assert.rejects(
    retryClient.beta.messages.create({
      model: 'gpt-5.5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    }),
    /OpenAI API 429/,
  )

  assert.equal(attempts, 1)

  globalThis.fetch = (async () => {
    return new Response(
      [
        'data: {"type":"response.output_item.added","item":{"type":"web_search_call","id":"ws_1","status":"in_progress"}}',
        'data: {"type":"response.output_item.done","item":{"type":"web_search_call","id":"ws_1","status":"completed","action":{"type":"search","query":"current example","queries":["fallback example","fallback evidence"]}}}',
        'data: {"type":"response.output_text.delta","delta":"Current example"}',
        'data: {"type":"response.output_text.annotation.added","item_id":"output_text_1","output_index":1,"content_index":0,"annotation_index":0,"annotation":{"type":"url_citation","url":"https://example.com/result","title":"Example Result","start_index":0,"end_index":14}}',
        'data: {"type":"response.output_text.annotation.added","item_id":"output_text_1","output_index":1,"content_index":0,"annotation_index":1,"annotation":{"type":"url_citation","url":"https://example.com/second","title":"Second Result","start_index":0,"end_index":14}}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2}}}',
        '',
      ].join('\n\n'),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    )
  }) as unknown as typeof fetch

  const { data: searchStream } = await rootURLClient.beta.messages
    .create({
      model: 'gpt-5.5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'search' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      stream: true,
    } as any)
    .withResponse()

  const searchEvents: any[] = []
  for await (const event of searchStream as unknown as AsyncIterable<any>) {
    searchEvents.push(event)
  }

  const searchStart = searchEvents.find(
    event =>
      event.type === 'content_block_start' &&
      event.content_block?.type === 'server_tool_use',
  )
  assert.equal(searchStart?.content_block.id, 'ws_1')
  assert.equal(searchStart?.content_block.name, 'web_search')
  assert.ok(
    searchEvents.some(
      event =>
        event.type === 'content_block_delta' &&
        event.delta?.type === 'input_json_delta' &&
        event.delta.partial_json === '{"query":"current example"}',
    ),
  )
  const searchResult = searchEvents.find(
    event =>
      event.type === 'content_block_start' &&
      event.content_block?.type === 'web_search_tool_result',
  )
  assert.equal(searchResult?.content_block.tool_use_id, 'ws_1')
  assert.deepEqual(searchResult?.content_block.content, [
    {
      type: 'web_search_result',
      url: 'https://example.com/result',
      title: 'Example Result',
    },
    {
      type: 'web_search_result',
      url: 'https://example.com/second',
      title: 'Second Result',
    },
  ])
  assert.ok(
    searchEvents.some(
      event =>
        event.type === 'message_delta' &&
        event.usage?.server_tool_use?.web_search_requests === 1,
    ),
  )

  const nonStreamingSearch = await rootURLClient.beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'search' }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  } as any)
  assert.deepEqual(nonStreamingSearch.content, [
    {
      type: 'server_tool_use',
      id: 'ws_1',
      name: 'web_search',
      input: { query: 'current example' },
    },
    { type: 'text', text: 'Current example' },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'ws_1',
      content: [
        {
          type: 'web_search_result',
          url: 'https://example.com/result',
          title: 'Example Result',
        },
        {
          type: 'web_search_result',
          url: 'https://example.com/second',
          title: 'Second Result',
        },
      ],
    },
  ])
  assert.equal(nonStreamingSearch.usage.server_tool_use.web_search_requests, 1)

  globalThis.fetch = (async () => {
    return new Response(
      [
        'data: {"type":"response.output_item.added","item":{"type":"web_search_call","id":"ws_array_first","status":"in_progress"}}',
        'data: {"type":"response.output_item.done","item":{"type":"web_search_call","id":"ws_array_first","status":"completed","action":{"type":"search","queries":["array first","second query"]}}}',
        'data: {"type":"response.output_item.added","item":{"type":"web_search_call","id":"ws_empty_first","status":"in_progress"}}',
        'data: {"type":"response.output_item.done","item":{"type":"web_search_call","id":"ws_empty_first","status":"completed","action":{"type":"search","queries":["","second query"]}}}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
        '',
      ].join('\n\n'),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    )
  }) as unknown as typeof fetch

  const { data: emptyFirstQueryStream } = await rootURLClient.beta.messages
    .create({
      model: 'gpt-5.5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'search' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      stream: true,
    } as any)
    .withResponse()

  const emptyFirstQueryEvents: any[] = []
  for await (const event of emptyFirstQueryStream as unknown as AsyncIterable<any>) {
    emptyFirstQueryEvents.push(event)
  }
  assert.deepEqual(
    emptyFirstQueryEvents
      .filter(
        event =>
          event.type === 'content_block_delta' &&
          event.delta?.type === 'input_json_delta',
      )
      .map(event => event.delta.partial_json),
    ['{"query":"array first"}'],
  )

  globalThis.fetch = (async () => {
    return new Response(
      'data: {"type":"response.output_item.added","item":{"type":"web_search_call","id":"ws_unfinished","status":"in_progress","action":{"type":"search","query":"unfinished example"}}}\n\n',
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    )
  }) as unknown as typeof fetch

  const { data: unfinishedSearchStream } = await rootURLClient.beta.messages
    .create({
      model: 'gpt-5.5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'search' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      stream: true,
    } as any)
    .withResponse()

  await assert.rejects(async () => {
    for await (const _event of unfinishedSearchStream as unknown as AsyncIterable<any>) {
      // Consume the stream so its terminal error is observed.
    }
  }, /Web search ws_unfinished did not complete/)

  globalThis.fetch = (async () => {
    return new Response(
      [
        'data: {"type":"response.output_item.added","item":{"type":"web_search_call","id":"ws_failed","status":"in_progress"}}',
        'data: {"type":"response.output_item.done","item":{"type":"web_search_call","id":"ws_failed","status":"failed","action":{"type":"search","query":"failed example"}}}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
        '',
      ].join('\n\n'),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    )
  }) as unknown as typeof fetch

  const { data: failedSearchStream } = await rootURLClient.beta.messages
    .create({
      model: 'gpt-5.5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'search' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      stream: true,
    } as any)
    .withResponse()

  await assert.rejects(async () => {
    for await (const _event of failedSearchStream as unknown as AsyncIterable<any>) {
      // Consume the stream so its terminal error is observed.
    }
  }, /Web search ws_failed failed/)

  globalThis.fetch = (async () => {
    return new Response(
      [
        'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_agent_1","call_id":"fc_agent_1","name":"Agent"}}',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_agent_1","delta":"{\\"description\\":\\"Research task\\",\\"prompt\\":\\"Check behavior\\",\\"subagent_type\\":\\"general-purpose\\",\\"isolation\\":\\"worktree\\"}"}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
        '',
      ].join('\n\n'),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    )
  }) as unknown as typeof fetch

  const agentStreamClient = createOpenAICompatClient({
    apiKey: 'sk-test-api-key',
    maxRetries: 0,
    timeout: 1000,
  })

  const { data: agentStream } = await agentStreamClient.beta.messages
    .create({
      model: 'gpt-5.5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'delegate this' }],
      tools: [
        {
          type: 'custom' as const,
          name: 'Agent',
          description: 'Launch agent',
          input_schema: {
            type: 'object' as const,
            properties: {
              description: { type: 'string' },
              prompt: { type: 'string' },
              subagent_type: { type: 'string' },
              isolation: { enum: ['worktree'] },
            },
            required: ['description', 'prompt'],
          },
        },
      ],
      stream: true,
    } as any)
    .withResponse()

  const agentEvents: any[] = []
  for await (const event of agentStream as unknown as AsyncIterable<any>) {
    agentEvents.push(event)
  }

  assert.ok(
    agentEvents.some(
      event =>
        event.type === 'content_block_delta' &&
        event.delta?.type === 'input_json_delta' &&
        event.delta.partial_json.includes('"isolation":"worktree"'),
    ),
  )

  globalThis.fetch = (async () => {
    return new Response(
      [
        'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_call_1","call_id":"fc_call_1","name":"Bash"}}',
        'data: {"type":"response.function_call_arguments.done","item_id":"fc_call_1","arguments":"{\\"command\\":\\"pwd\\"}"}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
        '',
      ].join('\n\n'),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    )
  }) as unknown as typeof fetch

  const streamClient = createOpenAICompatClient({
    apiKey: 'sk-test-api-key',
    maxRetries: 0,
    timeout: 1000,
  })

  const { data: stream } = await streamClient.beta.messages
    .create({
      model: 'gpt-5.5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'run pwd' }],
      tools: [
        {
          type: 'custom' as const,
          name: 'Bash',
          description: 'Run shell command',
          input_schema: {
            type: 'object' as const,
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      ],
      stream: true,
    } as any)
    .withResponse()

  const events: any[] = []
  for await (const event of stream as unknown as AsyncIterable<any>) {
    events.push(event)
  }

  assert.ok(
    events.some(
      event =>
        event.type === 'content_block_delta' &&
        event.delta?.type === 'input_json_delta' &&
        event.delta.partial_json === '{"command":"pwd"}',
    ),
  )
} finally {
  globalThis.fetch = originalFetch
  const { getOpenAIAuthInfo } = await import('../../utils/auth.js')
  getOpenAIAuthInfo.cache.clear?.()
  if (originalOpenAIBaseURL === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = originalOpenAIBaseURL
}

console.log('openai-compat.test.ts passed')
