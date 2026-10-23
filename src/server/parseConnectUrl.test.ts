import { describe, expect, it } from 'bun:test'
import { DirectConnectError } from './createDirectConnectSession.js'
import { parseConnectUrl } from './parseConnectUrl.js'

describe('parseConnectUrl', () => {
  it('maps cc://host:port/<token> to an http server URL and path token', () => {
    expect(parseConnectUrl('cc://127.0.0.1:8080/sk-ant-cc-abc')).toEqual({
      serverUrl: 'http://127.0.0.1:8080',
      authToken: 'sk-ant-cc-abc',
    })
  })

  it('accepts a URL without a token', () => {
    expect(parseConnectUrl('cc://example.test:9000')).toEqual({
      serverUrl: 'http://example.test:9000',
      authToken: undefined,
    })
    expect(parseConnectUrl('cc://[::1]:9000/t')).toEqual({
      serverUrl: 'http://[::1]:9000',
      authToken: 't',
    })
  })

  it('decodes a percent-encoded token', () => {
    expect(parseConnectUrl('cc://h:1/a%2Fb').authToken).toBe('a/b')
  })

  it('lets ?serverUrl= override the HTTP base URL but keeps the path token', () => {
    expect(
      parseConnectUrl(
        'cc://h:1/tok?serverUrl=https%3A%2F%2Fproxy.example.test%2Fcc%2F',
      ),
    ).toEqual({
      serverUrl: 'https://proxy.example.test/cc',
      authToken: 'tok',
    })
  })

  it('falls back to ?token= when the path has no token', () => {
    expect(parseConnectUrl('cc://h:1/?token=q').authToken).toBe('q')
  })

  it('rejects cc+unix:// explicitly', () => {
    expect(() => parseConnectUrl('cc+unix:///tmp/s.sock')).toThrow(
      'Unix socket connect (cc+unix://) is not supported',
    )
  })

  it('rejects malformed input without echoing the token', () => {
    for (const bad of [
      'http://h:1/secret-token',
      'cc://',
      'cc://h:notaport/secret-token',
      'cc://h:1/%E0%A4%A',
      'cc://h:1/secret-token?serverUrl=ftp://x',
      'cc://h:1/secret-token?serverUrl=not a url',
    ]) {
      let error: unknown
      try {
        parseConnectUrl(bad)
      } catch (err) {
        error = err
      }
      expect(error).toBeInstanceOf(DirectConnectError)
      expect((error as Error).message).not.toContain('secret-token')
    }
  })
})
