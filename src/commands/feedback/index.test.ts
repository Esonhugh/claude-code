import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const root = mkdtempSync(join(tmpdir(), 'feedback-opt-in-'))
process.env.HOME = root
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
const { enableConfigs } = await import('../../utils/config.js')
enableConfigs()

await import('../../commands.js')
const { default: feedback, feedbackDisabledReason } = await import('./index.js')
const { isFeedbackSurveyDisabled } = await import(
  '../../services/analytics/config.js'
)

function withEnv(env: Record<string, string>, run: () => void) {
  const saved = { ...process.env }
  try {
    for (const key of [
      'CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY',
      'DISABLE_TELEMETRY',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'ANTHROPIC_BASE_URL',
      'DISABLE_FEEDBACK_COMMAND',
      'DISABLE_BUG_COMMAND',
    ])
      delete process.env[key]
    process.env.NODE_ENV = 'production'
    Object.assign(process.env, env)
    run()
  } finally {
    process.env = saved
  }
}

test('feedback command and surveys are off unless Anthropic telemetry is opted in', () => {
  withEnv({}, () => {
    assert.equal(feedback.isEnabled(), false)
    assert.equal(isFeedbackSurveyDisabled(), true)
  })
})

test('feedback command and surveys are available after opting in', () => {
  withEnv({ CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY: '1' }, () => {
    assert.equal(feedback.isEnabled(), true)
    assert.equal(isFeedbackSurveyDisabled(), false)
  })
})

test('opted-in feedback stays off with DISABLE_TELEMETRY or a gateway base URL', () => {
  for (const env of [
    { DISABLE_TELEMETRY: '1' },
    { ANTHROPIC_BASE_URL: 'https://gateway.example.com' },
  ]) {
    withEnv({ CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY: '1', ...env }, () => {
      assert.equal(feedback.isEnabled(), false)
      assert.equal(isFeedbackSurveyDisabled(), true)
    })
  }
})

test('feedback switched off by env stays listed and answers with the reason like 2.1.311', () => {
  withEnv({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, () => {
    assert.equal(feedback.isEnabled(), true)
    assert.equal(
      feedbackDisabledReason(),
      '/feedback has been disabled via the CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC environment variable',
    )
  })
  withEnv({ CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY: '1', DISABLE_FEEDBACK_COMMAND: '1' }, () => {
    assert.equal(feedback.isEnabled(), true)
    assert.match(feedbackDisabledReason()!, /DISABLE_FEEDBACK_COMMAND environment variable$/)
  })
})
