import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getControlSocketPath, getPtySockPath, getSockDir, redactPipeNonce } from './protocol.js'

const platform = process.platform
const env = { ...process.env }

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'daemon-paths-'))
  delete process.env.TERMUX_VERSION
  delete process.env.PREFIX
})

afterEach(() => {
  setPlatform(platform)
  process.env = { ...env }
})

test('POSIX sockets live under /tmp, not the long macOS os.tmpdir()', () => {
  setPlatform('darwin')
  const dir = getSockDir()
  expect(dir).toMatch(new RegExp(`^/tmp/cc-daemon-${process.getuid?.() ?? 0}/[0-9a-f]{8}$`))
  expect(getControlSocketPath()).toBe(join(dir, 'control.sock'))
  expect(getPtySockPath('abcd1234')).toBe(join(dir, 'pty', 'abcd1234.sock'))
  // Unix socket paths must stay under the ~104 byte limit.
  expect(getPtySockPath('abcd1234').length).toBeLessThan(104)
})

test('Termux sockets live under $PREFIX/tmp', () => {
  setPlatform('android')
  process.env.TERMUX_VERSION = '0.118'
  process.env.PREFIX = '/data/data/com.termux/files/usr'
  expect(getControlSocketPath()).toMatch(/^\/data\/data\/com\.termux\/files\/usr\/tmp\/cc-daemon-\d+\/[0-9a-f]{8}\/control\.sock$/)
})

test('Windows uses named pipes keyed by a private pipe.key nonce', () => {
  setPlatform('win32')
  const control = getControlSocketPath()
  const match = /^\\\\\.\\pipe\\cc-daemon-([0-9a-f]{16})-control$/.exec(control)
  expect(match).not.toBeNull()
  const keyPath = join(process.env.CLAUDE_CONFIG_DIR!, 'daemon', 'pipe.key')
  expect(readFileSync(keyPath, 'utf8')).toBe(match![1]!)
  expect(statSync(keyPath).mode & 0o777).toBe(0o600)
  // The nonce is reused, so every process finds the same pipes.
  expect(getPtySockPath('abcd1234')).toBe(`\\\\.\\pipe\\cc-daemon-${match![1]}-pty-abcd1234`)
  expect(redactPipeNonce(`connect ENOENT ${control}`)).toBe('connect ENOENT \\\\.\\pipe\\cc-daemon-*-control')
})

test('an invalid pipe.key is replaced', () => {
  setPlatform('win32')
  getControlSocketPath()
  const keyPath = join(process.env.CLAUDE_CONFIG_DIR!, 'daemon', 'pipe.key')
  writeFileSync(keyPath, 'not-a-nonce')
  expect(getControlSocketPath()).toMatch(/^\\\\\.\\pipe\\cc-daemon-[0-9a-f]{16}-control$/)
  expect(readFileSync(keyPath, 'utf8')).toMatch(/^[0-9a-f]{16}$/)
})
