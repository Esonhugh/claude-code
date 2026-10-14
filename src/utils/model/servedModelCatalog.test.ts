import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fetchServedModelCatalog,
  getServedModelCatalogCachePath,
  getServedModelCatalogEndpoint,
  parseServedModelCatalog,
  type ServedModelCatalogScope,
} from './servedModelCatalog.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const scope: ServedModelCatalogScope = {
  provider: 'anthropic',
  endpoint: 'https://api.anthropic.com/api/organizations/org-a/model_selector/cc',
  authMethod: 'claude-ai-oauth',
  organizationUUID: 'org-a',
}

const catalog = {
  surface: 'cc',
  config: {
    id: 'cc',
    models: [
      {
        id: 'claude-opus-5-5',
        name: 'Opus 5.5',
        section: 'main',
        thinking: { type: 'adaptive', effort_options: [{ id: 'low' }, { id: 'max' }] },
      },
    ],
  },
}

test('parses the real model selector wire shape by surface', () => {
  const result = parseServedModelCatalog({
    model_selector_config: [
      { id: 'other', models: [{ id: 'wrong', name: 'Wrong surface' }] },
      catalog.config,
    ],
    model_selector_state: [
      { id: 'other', model: 'wrong' },
      { id: 'cc', model: 'claude-opus-5-5', selection_source: 'global_default' },
    ],
    organization_uuid: 'org-a',
  })

  expect(result).toEqual({
    surface: 'cc',
    config: catalog.config,
    state: { id: 'cc', model: 'claude-opus-5-5', selection_source: 'global_default' },
  })
})

test('builds the official organization model selector endpoint with the cc surface', () => {
  expect(getServedModelCatalogEndpoint('https://api.anthropic.com', 'org a')).toBe(
    'https://api.anthropic.com/api/organizations/org%20a/model_selector/cc',
  )
})

test('fetches the OAuth organization catalog and writes an identity-scoped cache', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'served-model-catalog-'))
  tempDirs.push(cacheDir)
  const requests: Array<{ url: string; headers: Record<string, string> }> = []

  const result = await fetchServedModelCatalog({
    scope,
    accessToken: 'test-token-never-logged',
    cacheDir,
    now: () => 1_000,
    request: async (url, options) => {
      requests.push({ url, headers: options.headers })
      return { status: 200, data: { catalog, staleAt: 10_000 }, headers: {} }
    },
  })

  expect(result?.config.models[0]?.id).toBe('claude-opus-5-5')
  expect(requests).toEqual([{
    url: scope.endpoint,
    headers: {
      Authorization: 'Bearer test-token-never-logged',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-client-platform': 'claude_code_cli',
      'x-organization-uuid': 'org-a',
    },
  }])

  const cachePath = getServedModelCatalogCachePath(scope, cacheDir)
  expect(JSON.parse(await readFile(cachePath, 'utf8'))).toEqual({
    version: 2,
    fetchedAt: 1_000,
    staleAt: 10_000,
    catalog,
  })
  expect(cachePath).toContain('org-a')
  expect(getServedModelCatalogCachePath({ ...scope, organizationUUID: 'org-b' }, cacheDir)).not.toBe(cachePath)
})

test('uses fresh cache, refreshes stale cache, and falls back to stale data on failure', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'served-model-catalog-'))
  tempDirs.push(cacheDir)
  let requestCount = 0

  const request = async () => {
    requestCount += 1
    return { status: 200, data: { catalog, staleAt: 3_000 }, headers: {} }
  }

  await fetchServedModelCatalog({ scope, accessToken: 'token-a', cacheDir, now: () => 1_000, request })
  await fetchServedModelCatalog({
    scope,
    accessToken: 'token-b',
    cacheDir,
    now: () => 2_000,
    request: async () => { throw new Error('must use fresh cache') },
  })
  expect(requestCount).toBe(1)

  const refreshed = await fetchServedModelCatalog({ scope, accessToken: 'token-c', cacheDir, now: () => 4_000, request })
  expect(refreshed).toEqual(catalog)
  expect(requestCount).toBe(2)

  const fallback = await fetchServedModelCatalog({
    scope,
    accessToken: 'token-d',
    cacheDir,
    now: () => 8_000,
    request: async () => { throw new Error('offline') },
  })
  expect(fallback).toEqual(catalog)
  expect(requestCount).toBe(2)
})

test('falls back to stale data on the official 404 response without retrying immediately', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'served-model-catalog-'))
  tempDirs.push(cacheDir)
  let requestCount = 0

  await fetchServedModelCatalog({
    scope,
    accessToken: 'token-a',
    cacheDir,
    now: () => 1_000,
    request: async () => ({ status: 200, data: { catalog, staleAt: 2_000 }, headers: {} }),
  })

  const result = await fetchServedModelCatalog({
    scope,
    accessToken: 'token-b',
    cacheDir,
    now: () => 3_000,
    request: async () => {
      requestCount += 1
      return { status: 404, data: { error: 'not found' }, headers: {} }
    },
  })

  expect(result).toEqual(catalog)
  expect(requestCount).toBe(1)
})

test('does not use a cache or request when no eligible OAuth scope is supplied', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'served-model-catalog-'))
  tempDirs.push(cacheDir)
  let requested = false

  const result = await fetchServedModelCatalog({
    scope: null,
    cacheDir,
    request: async () => {
      requested = true
      return { status: 200, data: { catalog }, headers: {} }
    },
  })

  expect(result).toBeUndefined()
  expect(requested).toBe(false)
})
