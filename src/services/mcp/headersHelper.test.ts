import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { setIsInteractive, setSessionTrustAccepted } = await import('../../bootstrap/state.js')
const { resetTrustDialogAcceptedCacheForTesting } = await import('../../utils/config.js')
const { getMcpHeadersFromHelper } = await import('./headersHelper.js')
import type { ScopedMcpServerConfig } from './types.js'

const credentialVars = {
  ANTHROPIC_API_KEY: 'sk-test-secret',
  MY_SERVICE_TOKEN: 'service-token',
  DB_PASSWORD: 'db-password',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
}
const echoEnv =
  `printf '{"apiKey":"%s","token":"%s","password":"%s","aws":"%s","server":"%s","home":"%s"}' ` +
  `"$ANTHROPIC_API_KEY" "$MY_SERVICE_TOKEN" "$DB_PASSWORD" "$AWS_SECRET_ACCESS_KEY" "$CLAUDE_CODE_MCP_SERVER_NAME" "$HOME"`

let dir: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-headers-helper-'))
  for (const [key, value] of Object.entries(credentialVars)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  setIsInteractive(false)
  setSessionTrustAccepted(false)
  resetTrustDialogAcceptedCacheForTesting()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setSessionTrustAccepted(false)
  resetTrustDialogAcceptedCacheForTesting()
})

const http = (headersHelper: string, extra: Partial<ScopedMcpServerConfig>) =>
  ({ type: 'http', url: 'https://mcp.example.test/mcp', headersHelper, ...extra }) as ScopedMcpServerConfig & {
    type: 'http'
    url: string
  }

test('a project headersHelper does not run under -p before the folder is trusted', async () => {
  const marker = join(dir, 'ran')
  const config = http(`touch '${marker}'; printf '{"X":"y"}'`, { scope: 'project' })
  expect(await getMcpHeadersFromHelper('repo', config)).toBeNull()
  expect(existsSync(marker)).toBe(false)
})

test('a project or plugin headersHelper runs without inherited credential env vars', async () => {
  setSessionTrustAccepted(true)
  for (const extra of [{ scope: 'project' }, { scope: 'user', pluginSource: 'demo@market' }] as const) {
    const headers = await getMcpHeadersFromHelper('repo', http(echoEnv, extra))
    expect(headers).toEqual({
      apiKey: '',
      token: '',
      password: '',
      aws: '',
      server: 'repo',
      home: process.env.HOME ?? '',
    })
  }
})

test('a user headersHelper keeps the inherited environment', async () => {
  const headers = await getMcpHeadersFromHelper('mine', http(echoEnv, { scope: 'user' }))
  expect(headers).toMatchObject({ apiKey: 'sk-test-secret', token: 'service-token', server: 'mine' })
})
