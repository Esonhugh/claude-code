import assert from 'node:assert/strict'
import { describe, it } from 'bun:test'
import type { SDKControlSSHFileSuggestionsRequest } from '../entrypoints/sdk/controlTypes.js'
import {
  assertManagedSSHCapability,
  queryRemoteFileSuggestions,
} from './remoteFileSuggestions.js'

const baseRequest: SDKControlSSHFileSuggestionsRequest = {
  subtype: 'ssh_file_suggestions',
  version: 1,
  query: 'pri',
  mode: 'fuzzy',
  limit: 2,
  ssh_remote_token: 'session-token',
}

describe('remote SSH file suggestions', () => {
  it('authenticates only managed SSH requests', () => {
    const validEnv = {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_SSH_REMOTE: '1',
      CLAUDE_CODE_SSH_REMOTE_TOKEN: 'session-token',
    }

    assert.doesNotThrow(() =>
      assertManagedSSHCapability('session-token', validEnv),
    )
    assert.throws(
      () => assertManagedSSHCapability('wrong-token', validEnv),
      /only available in managed SSH sessions/,
    )
    assert.throws(
      () =>
        assertManagedSSHCapability('session-token', {
          ...validEnv,
          CLAUDE_CODE_SSH_REMOTE: '0',
        }),
      /only available in managed SSH sessions/,
    )
  })

  it('returns bounded built-in fuzzy results without command hooks', async () => {
    const response = await queryRemoteFileSuggestions(baseRequest, {
      loadFuzzyIndex: async () => ({
        search: (_query, limit) =>
          [
            { path: 'src/print.ts', score: 10 },
            { path: 'src/private/', score: 8 },
            { path: 'src/printer.test.ts', score: 7 },
          ].slice(0, limit),
      }),
      getPathSuggestions: async () => {
        throw new Error('path provider must not run')
      },
    })

    assert.deepEqual(response, {
      items: [
        { path: 'src/print.ts', kind: 'file', score: 10 },
        { path: 'src/private/', kind: 'directory', score: 8 },
      ],
      incomplete: false,
    })
  })

  it('returns path results with remote insertion paths', async () => {
    const response = await queryRemoteFileSuggestions(
      { ...baseRequest, query: './src/pr', mode: 'path', limit: 10 },
      {
        loadFuzzyIndex: async () => {
          throw new Error('fuzzy provider must not run')
        },
        getPathSuggestions: async () => [
          { path: 'src/print.ts', kind: 'file' },
          { path: 'src/private/', kind: 'directory' },
        ],
      },
    )

    assert.equal(response.incomplete, false)
    assert.deepEqual(response.items.map(item => item.path), [
      'src/print.ts',
      'src/private/',
    ])
  })

  it('uses the remote top-level path scan for an empty fuzzy query', async () => {
    const response = await queryRemoteFileSuggestions(
      { ...baseRequest, query: '', show_on_empty: true },
      {
        loadFuzzyIndex: async () => {
          throw new Error('empty search must not wait for the fuzzy index')
        },
        getPathSuggestions: async () => [
          { path: 'src/', kind: 'directory' },
          { path: 'README.md', kind: 'file' },
        ],
      },
    )

    assert.deepEqual(response.items.map(item => item.path), ['src/', 'README.md'])
  })

  it('returns incomplete on a cold fuzzy index instead of waiting indefinitely', async () => {
    const response = await queryRemoteFileSuggestions(baseRequest, {
      loadFuzzyIndex: () => new Promise(() => {}),
      getPathSuggestions: async () => [],
      coldCacheWaitMs: 5,
      deadlineMs: 50,
    })

    assert.deepEqual(response, { items: [], incomplete: true })
  })

  it('keeps the cold fuzzy index building for a later retry', async () => {
    let providerSignal: AbortSignal | undefined
    const response = await queryRemoteFileSuggestions(baseRequest, {
      loadFuzzyIndex: signal => {
        providerSignal = signal
        return new Promise(() => {})
      },
      getPathSuggestions: async () => [],
      coldCacheWaitMs: 5,
      deadlineMs: 50,
    })

    assert.deepEqual(response, { items: [], incomplete: true })
    assert.equal(providerSignal?.aborted, false)
  })

  it('aborts an independent in-flight request and its provider', async () => {
    const controller = new AbortController()
    let providerSignal: AbortSignal | undefined
    const result = queryRemoteFileSuggestions(baseRequest, {
      signal: controller.signal,
      loadFuzzyIndex: signal => {
        providerSignal = signal
        return new Promise(() => {})
      },
      getPathSuggestions: async () => [],
      coldCacheWaitMs: 1000,
      deadlineMs: 2000,
    })

    controller.abort()
    await assert.rejects(result, /cancelled/)
    assert.equal(providerSignal?.aborted, true)
  })
})
