import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as execFile from '../execFileNoThrow.js'
import * as platform from '../platform.js'
import { withMacosTrustBundle } from './sandbox-adapter.js'

const dir = mkdtempSync(join(tmpdir(), 'cc-trust-'))
const pem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'
const saved = { CURL_CA_BUNDLE: process.env.CURL_CA_BUNDLE, SSL_CERT_FILE: process.env.SSL_CERT_FILE }
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

test('sandboxed commands on macOS trust the keychain roots through CURL_CA_BUNDLE and SSL_CERT_FILE', async () => {
  delete process.env.CURL_CA_BUNDLE
  delete process.env.SSL_CERT_FILE
  const os = spyOn(platform, 'getPlatform').mockReturnValue('macos')
  const security = spyOn(execFile, 'execFileNoThrow').mockResolvedValue({ stdout: pem, stderr: '', code: 0 })
  try {
    const out = await withMacosTrustBundle("env '/usr/bin/sandbox-exec' -p x bash -c 'curl'", dir)
    const bundle = join(dir, 'macos-trust-bundle.pem')
    expect(out).toBe(`CURL_CA_BUNDLE=${bundle} SSL_CERT_FILE=${bundle} env '/usr/bin/sandbox-exec' -p x bash -c 'curl'`)
    expect(readFileSync(bundle, 'utf8')).toBe(pem)
    expect(security.mock.calls[0]![1]).toContain('/System/Library/Keychains/SystemRootCertificates.keychain')

    // A bundle the user chose wins; other platforms are untouched.
    process.env.SSL_CERT_FILE = '/etc/my.pem'
    expect(await withMacosTrustBundle('cmd', dir)).toBe('cmd')
    delete process.env.SSL_CERT_FILE
    os.mockReturnValue('linux')
    expect(await withMacosTrustBundle('cmd', dir)).toBe('cmd')
  } finally {
    os.mockRestore()
    security.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
})
