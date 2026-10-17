import { afterAll, expect, mock, spyOn, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const previousApiKey = process.env.ANTHROPIC_API_KEY
process.env.ANTHROPIC_API_KEY = 'test-only'

const providers = await import('../utils/model/providers.js')
const bedrock = await import('../utils/model/bedrock.js')
const apiClient = await import('./api/client.js')

let clientModel: string | undefined
let requestModel: string | undefined
let requestSignal: AbortSignal | null | undefined
let vcrModel: string | undefined

const providerSpy = spyOn(providers, 'getAPIProvider').mockReturnValue(
  'firstParty',
)
spyOn(apiClient, 'getAnthropicClient').mockImplementation(
  async (options) => {
    clientModel = options.model
    return {
      beta: {
        messages: {
          countTokens: async (
            request: { model: string },
            options?: { signal?: AbortSignal | null },
          ) => {
            requestModel = request.model
            requestSignal = options?.signal
            return { input_tokens: 17 }
          },
        },
      },
    } as never
  },
)

mock.module('./vcr.js', () => ({
  withVCR: async (_messages: unknown[], callback: () => Promise<unknown>) =>
    callback(),
  withStreamingVCR: async function* (
    _messages: unknown[],
    callback: () => AsyncGenerator<unknown>,
  ) {
    yield* callback()
  },
  withTokenCountVCR: async (...args: unknown[]) => {
    const callbackIndex = typeof args[2] === 'function' ? 2 : 3
    vcrModel = callbackIndex === 3 ? (args[2] as string) : undefined
    return await (args[callbackIndex] as () => Promise<number | null>)()
  },
}))

const { countMessagesTokensWithAPI } = await import('./tokenEstimation.js')

afterAll(() => {
  mock.restore()
  if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = previousApiKey
})

test('uses the explicit runtime model for the request and VCR identity', async () => {
  const controller = new AbortController()
  const result = await countMessagesTokensWithAPI(
    [{ role: 'user', content: 'count me' }],
    [],
    'claude-sonnet-4-6',
    controller.signal,
  )

  expect(result).toBe(17)
  expect(clientModel).toBe('claude-sonnet-4-6')
  expect(requestModel).toBe('claude-sonnet-4-6')
  expect(requestSignal).toBe(controller.signal)
  expect(vcrModel).toBe('claude-sonnet-4-6')
})

test('rejects an already aborted token count without opening a request', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancel token count'))
  requestSignal = undefined

  await expect(
    countMessagesTokensWithAPI(
      [{ role: 'user', content: 'count me' }],
      [],
      'claude-sonnet-4-6',
      controller.signal,
    ),
  ).rejects.toThrow('cancel token count')
  expect(requestSignal).toBeUndefined()
})

test('propagates cancellation from an in-flight Bedrock token count', async () => {
  const controller = new AbortController()
  providerSpy.mockReturnValue('bedrock')
  spyOn(bedrock, 'isFoundationModel').mockReturnValueOnce(true)
  spyOn(bedrock, 'createBedrockRuntimeClient').mockResolvedValueOnce({
    send: async (_command: unknown, options?: { abortSignal?: AbortSignal }) => {
      expect(options?.abortSignal).toBe(controller.signal)
      controller.abort(new Error('cancel Bedrock token count'))
      throw controller.signal.reason
    },
  } as never)

  try {
    await expect(
      countMessagesTokensWithAPI(
        [{ role: 'user', content: 'count me' }],
        [],
        'anthropic.claude-sonnet-4-6-v1:0',
        controller.signal,
      ),
    ).rejects.toThrow('cancel Bedrock token count')
  } finally {
    providerSpy.mockReturnValue('firstParty')
  }
})
