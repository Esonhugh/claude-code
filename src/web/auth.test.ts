import { describe, expect, it } from 'bun:test'
import {
  allowedHosts,
  checkToken,
  cookieHeader,
  readCookie,
  signCookie,
  untrustedReason,
  verifyCookie,
} from './auth.js'

const key = Buffer.alloc(32, 7)
const hosts = allowedHosts(4000)

function req(headers: Record<string, string>): Request {
  return new Request('http://127.0.0.1:4000/api/sessions', { headers })
}

describe('token and cookie', () => {
  it('accepts only the exact token', () => {
    expect(checkToken('abc', 'abc')).toBe(true)
    expect(checkToken('abc', 'abd')).toBe(false)
    expect(checkToken('abc', 'abcd')).toBe(false)
    expect(checkToken('abc', null)).toBe(false)
  })

  it('verifies a signed cookie until it expires', () => {
    const now = 1_700_000_000_000
    const cookie = signCookie(key, now)
    expect(verifyCookie(key, cookie, now)).toBe(true)
    expect(verifyCookie(key, cookie, now + 8 * 24 * 3600 * 1000)).toBe(false)
    expect(verifyCookie(Buffer.alloc(32, 8), cookie, now)).toBe(false)
  })

  it('rejects tampered or malformed cookies', () => {
    const now = 1_700_000_000_000
    const [expiry, mac] = signCookie(key, now).split('.')
    expect(verifyCookie(key, `${Number(expiry) + 1}.${mac}`, now)).toBe(false)
    expect(verifyCookie(key, `${expiry}.${mac}.x`, now)).toBe(false)
    expect(verifyCookie(key, `abc.${mac}`, now)).toBe(false)
    expect(verifyCookie(key, undefined, now)).toBe(false)
    expect(verifyCookie(key, '', now)).toBe(false)
  })

  it('reads the cookie among others and sets strict attributes', () => {
    const r = req({ cookie: 'a=1; claude_web=v.x ; b=2' })
    expect(readCookie(r, 'claude_web')).toBe('v.x')
    expect(readCookie(r, 'missing')).toBeUndefined()
    const header = cookieHeader('v', false)
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Strict')
    expect(header).not.toContain('Secure')
  })
})

describe('untrustedReason', () => {
  it('accepts loopback hosts with a matching origin', () => {
    for (const host of ['127.0.0.1:4000', 'localhost:4000', '[::1]:4000']) {
      expect(
        untrustedReason(req({ host, origin: `http://${host}` }), hosts, {
          requireOrigin: true,
        }),
      ).toBeUndefined()
    }
  })

  it('rejects a foreign Host (DNS rebinding)', () => {
    expect(
      untrustedReason(
        req({ host: 'evil.example:4000', origin: 'http://evil.example:4000' }),
        hosts,
        { requireOrigin: true },
      ),
    ).toBe('host')
    expect(
      untrustedReason(req({ host: '127.0.0.1:4001' }), hosts, {
        requireOrigin: false,
      }),
    ).toBe('host')
  })

  it('rejects cross-site and foreign or null origins', () => {
    const host = '127.0.0.1:4000'
    const opts = { requireOrigin: true }
    expect(
      untrustedReason(
        req({ host, origin: `http://${host}`, 'sec-fetch-site': 'cross-site' }),
        hosts,
        opts,
      ),
    ).toBe('cross-site')
    expect(
      untrustedReason(req({ host, origin: 'http://evil.example' }), hosts, opts),
    ).toBe('origin')
    expect(untrustedReason(req({ host, origin: 'null' }), hosts, opts)).toBe(
      'origin',
    )
    expect(
      untrustedReason(req({ host, origin: 'http://localhost:4000' }), hosts, opts),
    ).toBe('origin')
  })

  it('requires an Origin only when asked to', () => {
    const r = req({ host: '127.0.0.1:4000' })
    expect(untrustedReason(r, hosts, { requireOrigin: true })).toBe('origin')
    expect(untrustedReason(r, hosts, { requireOrigin: false })).toBeUndefined()
  })

  it('adds trusted hosts with the server port', () => {
    const extended = allowedHosts(4000, [
      'Box.local',
      'other:9',
      '[fd00::5]',
      '[fe80::1]:7',
    ])
    expect(extended.has('box.local:4000')).toBe(true)
    expect(extended.has('other:9')).toBe(true)
    expect(extended.has('[fd00::5]:4000')).toBe(true)
    expect(extended.has('[fe80::1]:7')).toBe(true)
  })
})
