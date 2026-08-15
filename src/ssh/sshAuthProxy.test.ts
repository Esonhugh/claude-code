import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'bun:test'
import { startSSHAuthProxy } from './sshAuthProxy.js'

function requestUnixSocket(
  socketPath: string,
  headers: Record<string, string>,
  path = '/v1/messages?beta=true',
  body = '{"model":"test"}',
): Promise<{
  statusCode: number
  body: string
  headers: Record<string, string | string[] | undefined>
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method: 'POST',
        path,
        headers,
      },
      res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => {
          body += chunk
        })
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body,
            headers: res.headers,
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('SSH auth proxy', () => {
  it('forwards only OpenAI Responses requests with local Platform auth', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-ssh-proxy-test-'))
    let observedUrl = ''
    let observedHeaders: Headers | undefined
    let fetches = 0
    const proxy = await startSSHAuthProxy({
      socketPath: join(dir, 'proxy.sock'),
      provider: 'openai',
      upstream: 'https://api.openai.com/v1',
      getAuth: () => ({
        kind: 'api-key',
        headers: { authorization: 'Bearer local-openai-key' },
      }),
      fetch: async (input, init) => {
        fetches++
        observedUrl = String(input)
        observedHeaders = new Headers(init?.headers)
        return new Response('ok', { status: 200 })
      },
    })

    try {
      const response = await requestUnixSocket(
        proxy.socketPath,
        {
          authorization: 'Bearer remote-token',
          'x-api-key': 'remote-key',
          'chatgpt-account-id': 'remote-account',
          'content-type': 'application/json',
        },
        '/responses',
      )

      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.body, 'ok')
      assert.equal(observedUrl, 'https://api.openai.com/v1/responses')
      assert.equal(observedHeaders?.get('authorization'), 'Bearer local-openai-key')
      assert.equal(observedHeaders?.has('x-api-key'), false)
      assert.equal(observedHeaders?.has('chatgpt-account-id'), false)
      assert.equal(observedHeaders?.get('host'), 'api.openai.com')

      const rejected = await requestUnixSocket(
        proxy.socketPath,
        { authorization: 'Bearer remote-token' },
        '/v1/files',
      )
      assert.equal(rejected.statusCode, 404, rejected.body)
      assert.equal(fetches, 1)
    } finally {
      proxy.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('injects local ChatGPT OAuth and account headers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-ssh-proxy-test-'))
    let observedUrl = ''
    let observedHeaders: Headers | undefined
    const proxy = await startSSHAuthProxy({
      socketPath: join(dir, 'proxy.sock'),
      provider: 'openai',
      upstream: 'https://chatgpt.com/backend-api/codex',
      getAuth: () => ({
        kind: 'oauth',
        headers: {
          authorization: 'Bearer local-chatgpt-token',
          'chatgpt-account-id': 'local-account',
          origin: 'https://chatgpt.com',
        },
      }),
      fetch: async (input, init) => {
        observedUrl = String(input)
        observedHeaders = new Headers(init?.headers)
        return new Response(null, { status: 204 })
      },
    })

    try {
      const response = await requestUnixSocket(
        proxy.socketPath,
        {
          authorization: 'Bearer remote-token',
          'chatgpt-account-id': 'remote-account',
          origin: 'https://attacker.invalid',
        },
        '/responses',
      )
      assert.equal(response.statusCode, 204, response.body)
      assert.equal(
        observedUrl,
        'https://chatgpt.com/backend-api/codex/responses',
      )
      assert.equal(
        observedHeaders?.get('authorization'),
        'Bearer local-chatgpt-token',
      )
      assert.equal(observedHeaders?.get('chatgpt-account-id'), 'local-account')
      assert.equal(observedHeaders?.get('origin'), 'https://chatgpt.com')
    } finally {
      proxy.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects oversized request bodies before authentication or upstream fetch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-ssh-proxy-test-'))
    let authCalls = 0
    let fetches = 0
    const proxy = await startSSHAuthProxy({
      socketPath: join(dir, 'proxy.sock'),
      provider: 'openai',
      upstream: 'https://api.openai.com/v1',
      getAuth: () => {
        authCalls++
        return {
          kind: 'api-key',
          headers: { authorization: 'Bearer local-key' },
        }
      },
      fetch: async () => {
        fetches++
        return new Response(null, { status: 204 })
      },
    })

    try {
      authCalls = 0
      const response = await requestUnixSocket(
        proxy.socketPath,
        { 'content-type': 'application/json' },
        '/responses',
        'x'.repeat(33 * 1024 * 1024),
      )
      assert.equal(response.statusCode, 413, response.body)
      assert.equal(authCalls, 0)
      assert.equal(fetches, 0)
    } finally {
      proxy.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects non-loopback plaintext OpenAI upstreams', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-ssh-proxy-test-'))
    try {
      await assert.rejects(
        startSSHAuthProxy({
          socketPath: join(dir, 'proxy.sock'),
          provider: 'openai',
          upstream: 'http://gateway.example.test/v1',
          getAuth: () => ({
            kind: 'api-key',
            headers: { authorization: 'Bearer local-key' },
          }),
        }),
        /requires HTTPS for non-loopback upstreams/,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('only forwards Anthropic message and token-count requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-ssh-proxy-test-'))
    let authCalls = 0
    const observedUrls: string[] = []
    const proxy = await startSSHAuthProxy({
      socketPath: join(dir, 'proxy.sock'),
      provider: 'anthropic',
      getAuth: () => {
        authCalls++
        return {
          kind: 'oauth',
          headers: { authorization: 'Bearer local-token' },
        }
      },
      fetch: async input => {
        observedUrls.push(String(input))
        return new Response(null, { status: 204 })
      },
    })

    try {
      authCalls = 0
      const messages = await requestUnixSocket(
        proxy.socketPath,
        {},
        '/v1/messages?beta=true',
      )
      const countTokens = await requestUnixSocket(
        proxy.socketPath,
        {},
        '/v1/messages/count_tokens?beta=true',
      )
      const files = await requestUnixSocket(
        proxy.socketPath,
        {},
        '/v1/files',
      )
      const arbitrary = await requestUnixSocket(
        proxy.socketPath,
        {},
        '/v1/organizations',
      )

      assert.equal(messages.statusCode, 204, messages.body)
      assert.equal(countTokens.statusCode, 204, countTokens.body)
      assert.equal(files.statusCode, 404, files.body)
      assert.equal(arbitrary.statusCode, 404, arbitrary.body)
      assert.deepEqual(observedUrls, [
        'https://api.anthropic.com/v1/messages?beta=true',
        'https://api.anthropic.com/v1/messages/count_tokens?beta=true',
      ])
      assert.equal(authCalls, 2)
    } finally {
      proxy.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('strips remote credentials and injects local OAuth auth', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-ssh-proxy-test-'))
    let observedUrl = ''
    let observedHeaders: Headers | undefined
    const proxy = await startSSHAuthProxy({
      socketPath: join(dir, 'proxy.sock'),
      getAuth: () => ({
        kind: 'oauth',
        headers: {
          authorization: 'Bearer local-token',
          'anthropic-beta': 'oauth-beta',
        },
      }),
      fetch: async (input, init) => {
        observedUrl = String(input)
        observedHeaders = new Headers(init?.headers)
        return new Response('ok', {
          status: 201,
          headers: { 'set-cookie': 'local-session=secret' },
        })
      },
    })

    try {
      const response = await requestUnixSocket(proxy.socketPath, {
        host: 'untrusted.example',
        authorization: 'Bearer remote-token',
        'x-api-key': 'remote-key',
        cookie: 'remote-session=untrusted',
        'content-type': 'application/json',
      })

      assert.equal(response.statusCode, 201, response.body)
      assert.equal(response.body, 'ok')
      assert.equal(observedUrl, 'https://api.anthropic.com/v1/messages?beta=true')
      assert.equal(observedHeaders?.get('authorization'), 'Bearer local-token')
      assert.equal(observedHeaders?.has('x-api-key'), false)
      assert.equal(observedHeaders?.has('cookie'), false)
      assert.equal(observedHeaders?.get('host'), 'api.anthropic.com')
      assert.equal(response.headers['set-cookie'], undefined)
    } finally {
      proxy.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('injects local API key auth', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-ssh-proxy-test-'))
    let observedHeaders: Headers | undefined
    const proxy = await startSSHAuthProxy({
      socketPath: join(dir, 'proxy.sock'),
      getAuth: () => ({
        kind: 'api-key',
        headers: { 'x-api-key': 'local-key' },
      }),
      fetch: async (_input, init) => {
        observedHeaders = new Headers(init?.headers)
        return new Response(null, { status: 204 })
      },
    })

    try {
      const response = await requestUnixSocket(proxy.socketPath, {})
      assert.equal(response.statusCode, 204, response.body)
      assert.equal(observedHeaders?.get('x-api-key'), 'local-key')
      assert.equal(observedHeaders?.has('authorization'), false)
    } finally {
      proxy.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('forwards to a configured Anthropic gateway with bearer auth', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-ssh-proxy-test-'))
    let observedUrl = ''
    let observedHeaders: Headers | undefined
    const proxy = await startSSHAuthProxy({
      socketPath: join(dir, 'proxy.sock'),
      upstream: 'https://gateway.example.test/anthropic',
      getAuth: () => ({
        kind: 'api-key',
        headers: { authorization: 'Bearer gateway-token' },
      }),
      fetch: async (input, init) => {
        observedUrl = String(input)
        observedHeaders = new Headers(init?.headers)
        return new Response(null, { status: 204 })
      },
    })

    try {
      const response = await requestUnixSocket(proxy.socketPath, {
        authorization: 'Bearer remote-token',
        'x-api-key': 'remote-key',
      })
      assert.equal(response.statusCode, 204, response.body)
      assert.equal(
        observedUrl,
        'https://gateway.example.test/anthropic/v1/messages?beta=true',
      )
      assert.equal(
        observedHeaders?.get('authorization'),
        'Bearer gateway-token',
      )
      assert.equal(observedHeaders?.has('x-api-key'), false)
      assert.equal(observedHeaders?.get('host'), 'gateway.example.test')
    } finally {
      proxy.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
