import { afterEach, expect, test } from 'bun:test'
import { buildSettingSourcesProperties } from './status.js'

const baseUrl = process.env.ANTHROPIC_BASE_URL

afterEach(() => {
  if (baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = baseUrl
})

test('a custom base URL explains why remote settings and policy were not fetched', () => {
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
  const properties = buildSettingSourcesProperties()
  expect(properties.slice(1)).toEqual([
    {
      label: 'Managed settings (remote)',
      value: 'not fetched — not available with a custom ANTHROPIC_BASE_URL',
    },
    {
      label: 'Organization policy',
      value: 'not fetched with a custom ANTHROPIC_BASE_URL',
    },
  ])
})

test('the Anthropic API host adds no remote policy lines', () => {
  delete process.env.ANTHROPIC_BASE_URL
  expect(buildSettingSourcesProperties().map(p => p.label)).toEqual([
    'Setting sources',
  ])
})
