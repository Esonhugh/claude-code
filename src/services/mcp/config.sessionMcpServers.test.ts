import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = mkdtempSync(join(tmpdir(), 'session-mcp-'))
process.env.CLAUDE_CONFIG_DIR = configDir
const { setFlagSettingsInline } = await import('../../bootstrap/state.js')
const { resetSettingsCache } = await import('../../utils/settings/settingsCache.js')
const { isMcpServerDisabled, setMcpServerEnabled } = await import('./config.js')

afterAll(() => rmSync(configDir, { recursive: true, force: true }))

function flag(sessionMcpServers: Record<string, boolean> | undefined) {
  setFlagSettingsInline(sessionMcpServers ? { sessionMcpServers } : null)
  resetSettingsCache()
}

test('--settings sessionMcpServers turns servers on and off for this process only', () => {
  setMcpServerEnabled('globallyOff', false)
  flag(undefined)
  expect(isMcpServerDisabled('globallyOff')).toBe(true)
  expect(isMcpServerDisabled('plain')).toBe(false)

  flag({ globallyOff: true, plain: false })
  expect(isMcpServerDisabled('globallyOff')).toBe(false)
  expect(isMcpServerDisabled('plain')).toBe(true)

  flag(undefined)
  expect(isMcpServerDisabled('globallyOff')).toBe(true)
  expect(isMcpServerDisabled('plain')).toBe(false)
})
