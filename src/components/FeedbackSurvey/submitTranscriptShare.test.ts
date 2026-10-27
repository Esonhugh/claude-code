import { afterEach, expect, spyOn, test } from 'bun:test'
import axios from 'axios'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const root = mkdtempSync(join(tmpdir(), 'transcript-share-'))
process.env.HOME = root
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
const { enableConfigs } = await import('../../utils/config.js')
enableConfigs()

const http = await import('../../utils/http.js')
const { submitTranscriptShare } = await import('./submitTranscriptShare.js')

spyOn(http, 'getAuthHeaders').mockReturnValue({
  headers: { 'x-api-key': 'sk-ant-test' },
})
const post = spyOn(axios, 'post').mockResolvedValue({
  status: 200,
  data: { transcript_id: 't' },
})

const savedEnv = { ...process.env }

afterEach(() => {
  process.env = { ...savedEnv }
  post.mockClear()
})

async function share(env: Record<string, string>) {
  process.env.NODE_ENV = 'production'
  for (const key of [
    'CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY',
    'DISABLE_TELEMETRY',
    'DO_NOT_TRACK',
    'ANTHROPIC_BASE_URL',
  ]) {
    delete process.env[key]
  }
  Object.assign(process.env, env)
  return submitTranscriptShare([], 'bad_feedback_survey', 'a')
}

test('transcript share never uploads without the telemetry opt-in', async () => {
  expect((await share({})).success).toBe(false)
  expect(post).not.toHaveBeenCalled()
})

test('transcript share respects DO_NOT_TRACK even when opted in', async () => {
  const result = await share({
    CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
  })
  expect(result.success).toBe(false)
  expect(post).not.toHaveBeenCalled()
})

test('transcript share uploads once telemetry is opted in', async () => {
  const result = await share({ CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY: '1' })
  expect(result.success).toBe(true)
  expect(post).toHaveBeenCalledTimes(1)
})
