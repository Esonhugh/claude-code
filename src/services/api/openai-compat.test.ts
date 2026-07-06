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

  assert.deepEqual(requests[0]!.body.reasoning, { effort: 'xhigh' })

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
