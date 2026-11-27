import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs'
import axios, { AxiosError, type AxiosResponse } from 'axios'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import * as state from '../../bootstrap/state.js'
import * as auth from '../../utils/auth.js'
import * as config from '../../utils/config.js'
import * as http from '../../utils/http.js'
import { isAnalyticsDisabled } from './config.js'
import { FirstPartyEventLoggingExporter } from './firstPartyEventLoggingExporter.js'

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'NODE_ENV', 'CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY', 'CLAUDE_CODE_USE_OPENAI'] as const
const previousEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
let dir: string
const spies: { mockRestore(): void }[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), '1p-exporter-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  delete process.env.ANTHROPIC_BASE_URL
  spies.push(
    spyOn(config, 'checkHasTrustDialogAccepted').mockReturnValue(true),
    spyOn(state, 'getIsNonInteractiveSession').mockReturnValue(true),
    spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(false),
  )
})

afterEach(async () => {
  spies.splice(0).forEach(spy => spy.mockRestore())
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key]
    else process.env[key] = previousEnv[key]
  }
  await rm(dir, { recursive: true, force: true })
})

const record = {
  instrumentationScope: { name: 'com.anthropic.claude_code.events' },
  attributes: { event_name: 'tengu_fixture', event_id: 'fixture-id' },
  body: 'tengu_fixture',
  hrTime: [0, 0],
} as unknown as ReadableLogRecord

function exportOnce(): Promise<ExportResult> {
  const exporter = new FirstPartyEventLoggingExporter({ schedule: () => () => {} })
  return new Promise(resolve => void exporter.export([record], resolve))
}

test('does not send events without an Anthropic credential', async () => {
  spies.push(spyOn(http, 'getAuthHeaders').mockReturnValue({ headers: {}, error: 'No API key available' }))
  const post = spyOn(axios, 'post')
  spies.push(post)
  expect((await exportOnce()).code).toBe(ExportResultCode.FAILED)
  expect(post).not.toHaveBeenCalled()
})

test('sends events with the credential to api.anthropic.com only', async () => {
  spies.push(spyOn(http, 'getAuthHeaders').mockReturnValue({ headers: { 'x-api-key': 'fixture-only' } }))
  const post = spyOn(axios, 'post').mockResolvedValue({ data: {} } as AxiosResponse)
  spies.push(post)
  expect((await exportOnce()).code).toBe(ExportResultCode.SUCCESS)
  expect(post).toHaveBeenCalledTimes(1)
  const [url, , options] = post.mock.calls[0]!
  expect(url).toBe('https://api.anthropic.com/api/event_logging/batch')
  expect(options?.headers).toMatchObject({ 'x-api-key': 'fixture-only' })
})

test('a 401 is not retried without the credential', async () => {
  spies.push(spyOn(http, 'getAuthHeaders').mockReturnValue({ headers: { 'x-api-key': 'fixture-only' } }))
  const unauthorized = new AxiosError('Unauthorized', '401', undefined, undefined, { status: 401 } as AxiosResponse)
  const post = spyOn(axios, 'post').mockRejectedValue(unauthorized)
  spies.push(post)
  expect((await exportOnce()).code).toBe(ExportResultCode.FAILED)
  expect(post).toHaveBeenCalledTimes(1)
})

test('analytics stay off for a non-Anthropic provider even when opted in', () => {
  process.env.NODE_ENV = 'production'
  process.env.CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY = '1'
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  expect(isAnalyticsDisabled()).toBe(true)
})
