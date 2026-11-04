import { describe, expect, it } from 'bun:test'
import { firstPreviewUrl, previewTarget } from './webPreview'

const local = { uiOrigin: 'http://127.0.0.1:4000', origins: [] }

describe('previewTarget', () => {
  it('accepts loopback links on any port when the UI is opened locally', () => {
    for (const [href, out] of [
      ['http://localhost:5173/', 'http://localhost:5173/'],
      ['http://LOCALHOST:3000/app?x=1#y', 'http://localhost:3000/app?x=1#y'],
      ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/'],
      ['https://127.0.0.1:8443/a', 'https://127.0.0.1:8443/a'],
      ['http://localhost/', 'http://localhost/'],
    ]) {
      expect(previewTarget(href!, local)).toBe(out!)
    }
    expect(previewTarget('http://localhost:5173/', { ...local, uiOrigin: 'http://localhost:4000' })).toBe(
      'http://localhost:5173/',
    )
    expect(previewTarget('http://localhost:5173/', { ...local, uiOrigin: 'http://[::1]:4000' })).toBe(
      'http://localhost:5173/',
    )
  })

  it('refuses loopback hosts the CSP does not let the page frame', () => {
    expect(previewTarget('http://127.0.0.2:3000/', local)).toBeUndefined()
    expect(previewTarget('http://app.localhost:3000/', local)).toBeUndefined()
    expect(previewTarget('http://[::1]:3000/', local)).toBeUndefined()
    expect(previewTarget('http://[0:0:0:0:0:0:0:1]:3000/', local)).toBeUndefined()
  })

  it('refuses the UI itself under any loopback name, including its /api', () => {
    for (const href of [
      'http://127.0.0.1:4000/',
      'http://127.0.0.1:4000/api/info',
      'http://localhost:4000/api/files/x?path=/etc/passwd',
      'http://[::1]:4000/',
      'https://127.0.0.1:4000/',
    ]) {
      expect(previewTarget(href, local)).toBeUndefined()
    }
    const lan = { uiOrigin: 'http://192.168.1.5:4000', origins: ['http://192.168.1.5:4000'] }
    expect(previewTarget('http://192.168.1.5:4000/api/info', lan)).toBeUndefined()
  })

  it('hides loopback links when the page is opened from another device', () => {
    const lan = { uiOrigin: 'http://192.168.1.5:4000', origins: ['http://dev.internal:8080'] }
    expect(previewTarget('http://localhost:5173/', lan)).toBeUndefined()
    expect(previewTarget('http://127.0.0.1:5173/', lan)).toBeUndefined()
    expect(previewTarget('http://dev.internal:8080/page', lan)).toBe('http://dev.internal:8080/page')
  })

  it('accepts only the configured origins elsewhere', () => {
    const env = { ...local, origins: ['http://dev.internal:8080', 'https://grafana.lan'] }
    expect(previewTarget('http://dev.internal:8080/x', env)).toBe('http://dev.internal:8080/x')
    expect(previewTarget('https://grafana.lan/d/1', env)).toBe('https://grafana.lan/d/1')
    expect(previewTarget('https://grafana.lan:444/', env)).toBeUndefined()
    expect(previewTarget('http://grafana.lan/', env)).toBeUndefined()
    expect(previewTarget('http://dev.internal:8081/', env)).toBeUndefined()
    expect(previewTarget('https://example.com/', env)).toBeUndefined()
    expect(previewTarget('http://192.168.1.9:3000/', env)).toBeUndefined()
  })

  it('refuses other schemes, credentials and junk', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript://localhost:3000/%0aalert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://localhost:21/',
      'ws://localhost:3000/',
      'blob:http://localhost:3000/abc',
      'http://user:pass@localhost:3000/',
      'http://user@localhost:3000/',
      '//localhost:3000/',
      '/api/info',
      'not a url',
      '',
    ]) {
      expect(previewTarget(href, local)).toBeUndefined()
    }
  })
})

describe('firstPreviewUrl', () => {
  const target = (href: string) => previewTarget(href, local)

  it('finds the first frameable URL in dev server output', () => {
    const out = '  VITE v5 ready\n  ➜  Network: http://192.168.1.9:5173/\n  ➜  Local:   http://localhost:5173/\n'
    expect(firstPreviewUrl(out, target)).toBe('http://localhost:5173/')
    expect(firstPreviewUrl('Listening on http://127.0.0.1:3000.', target)).toBe('http://127.0.0.1:3000/')
    expect(firstPreviewUrl('(see http://localhost:8000/)', target)).toBe('http://localhost:8000/')
    expect(firstPreviewUrl('no links here; https://example.com', target)).toBeUndefined()
  })
})
