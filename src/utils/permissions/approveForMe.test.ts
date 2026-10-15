import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Auto mode is compiled behind TRANSCRIPT_CLASSIFIER; run the assertions in a child with it enabled.
const childFlag = 'CLAUDE_CODE_APPROVE_FOR_ME_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('Approve for me gating (TRANSCRIPT_CLASSIFIER child)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-approve-for-me-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_USE_)/.test(key),
    ))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=TRANSCRIPT_CLASSIFIER', import.meta.path], {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 120_000)
} else {
const { getChatGPTOAuthInfo, getOpenAIAuthInfo } = await import('../auth.js')
const { modelSupportsAutoMode } = await import('../betas.js')
const { getPermissionModeFooterLabel, isApproveForMeAvailable } = await import('./approveForMe.js')
const { getAutoModeEnabledState, initialPermissionModeFromCLI } = await import('./permissionSetup.js')
const { getNextPermissionMode } = await import('./getNextPermissionMode.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')

const saved = {
  HOME: process.env.HOME,
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_AUTH_TOKEN: process.env.OPENAI_AUTH_TOKEN,
  CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
}
let home: string

function useAuthFile(auth: unknown) {
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify(auth))
  getOpenAIAuthInfo.cache.clear?.()
  getChatGPTOAuthInfo.cache.clear?.()
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'approve-for-me-'))
  process.env.HOME = home
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_AUTH_TOKEN
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  getOpenAIAuthInfo.cache.clear?.()
  getChatGPTOAuthInfo.cache.clear?.()
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  getOpenAIAuthInfo.cache.clear?.()
  getChatGPTOAuthInfo.cache.clear?.()
  rmSync(home, { recursive: true, force: true })
})

test('Approve for me requires OpenAI mode with a ChatGPT OAuth login', () => {
  useAuthFile({ auth_mode: 'chatgpt', tokens: { access_token: 'oauth-access' } })
  expect(isApproveForMeAvailable()).toBe(false)

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  expect(isApproveForMeAvailable()).toBe(true)
})

test('an OpenAI API key or token is not an OAuth login', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  useAuthFile({ OPENAI_API_KEY: 'sk-file' })
  expect(isApproveForMeAvailable()).toBe(false)

  useAuthFile({ auth_mode: 'chatgpt', tokens: { access_token: 'oauth-access' } })
  process.env.OPENAI_API_KEY = 'sk-env'
  getOpenAIAuthInfo.cache.clear?.()
  expect(isApproveForMeAvailable()).toBe(false)
})

test('auto mode model support follows official outside OpenAI mode and Approve for me inside it', () => {
  expect(modelSupportsAutoMode('claude-opus-5-5')).toBe(true)
  expect(modelSupportsAutoMode('claude-opus-4-6')).toBe(true)
  expect(modelSupportsAutoMode('claude-opus-4-5')).toBe(false)
  expect(modelSupportsAutoMode('claude-3-5-sonnet-20241022')).toBe(false)
  for (const model of ['claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-opus-4-0', 'claude-sonnet-4-0'])
    expect(modelSupportsAutoMode(model)).toBe(false)

  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  expect(modelSupportsAutoMode('us.anthropic.claude-sonnet-4-20250514-v1:0')).toBe(false)
  expect(modelSupportsAutoMode('claude-opus-4-6')).toBe(false)
  expect(modelSupportsAutoMode('claude-haiku-5')).toBe(false)
  expect(modelSupportsAutoMode('claude-opus-4-7')).toBe(true)
  delete process.env.CLAUDE_CODE_USE_BEDROCK

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  useAuthFile({ OPENAI_API_KEY: 'sk-file' })
  expect(modelSupportsAutoMode('gpt-5.6-sol')).toBe(false)
  useAuthFile({ auth_mode: 'chatgpt', tokens: { access_token: 'oauth-access' } })
  expect(modelSupportsAutoMode('gpt-5.6-sol')).toBe(true)
})

test('a Claude API key gets auto mode like a Claude login', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real'
  expect(modelSupportsAutoMode('claude-opus-5-5')).toBe(true)
  expect(initialPermissionModeFromCLI({ permissionModeCli: 'auto', dangerouslySkipPermissions: false }).mode).toBe('auto')
})

test('Shift+Tab moves from accept edits straight into auto mode, with no opt-in step', () => {
  const context = { ...getDefaultAppState().toolPermissionContext, mode: 'acceptEdits' as const, isAutoModeAvailable: true }
  expect(getNextPermissionMode(context)).toBe('auto')
  expect(getNextPermissionMode({ ...context, mode: 'auto' })).toBe('default')
})

test('a missing rollout value leaves auto mode enabled like official', () => {
  expect(getAutoModeEnabledState()).toBe('enabled')
})

test('--permission-mode auto starts in auto except in OpenAI mode without the ChatGPT login', () => {
  const start = () => initialPermissionModeFromCLI({ permissionModeCli: 'auto', dangerouslySkipPermissions: false }).mode
  expect(start()).toBe('auto')

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  useAuthFile({ OPENAI_API_KEY: 'sk-file' })
  expect(start()).toBe('default')

  useAuthFile({ auth_mode: 'chatgpt', tokens: { access_token: 'oauth-access' } })
  expect(start()).toBe('auto')
})

test('the footer names auto mode "auto (Approve for me)" and leaves other modes unchanged', () => {
  expect(getPermissionModeFooterLabel('acceptEdits')).toBe('accept edits')
  expect(getPermissionModeFooterLabel('auto')).toBe('auto mode')

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  useAuthFile({ auth_mode: 'chatgpt', tokens: { access_token: 'oauth-access' } })
  expect(getPermissionModeFooterLabel('auto')).toBe('auto (Approve for me)')
  expect(getPermissionModeFooterLabel('bypassPermissions')).toBe('bypass permissions')
})
}
