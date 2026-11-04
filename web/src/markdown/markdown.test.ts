import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { Markdown } from './Markdown'
import { normalizeMathDelimiters, splitSettled } from './parse'
import { safeImageSrc, safeLinkHref } from './safeUrl'
import { stripAnsi, toolMessage, toolSummary } from '../tools'
import { previewTarget, WebPreviewContext } from '../webPreview'

const html = (text: string, streaming = false) =>
  renderToStaticMarkup(createElement(Markdown, { text, streaming }))

describe('Markdown', () => {
  it('renders GFM blocks', () => {
    const out = html(
      '# Title\n\n**bold** _em_ ~~gone~~ `code`\n\n| a | b |\n| :- | -: |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n> quote',
    )
    expect(out).toContain('<h2>Title</h2>')
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('<del>gone</del>')
    expect(out).toContain('<code>code</code>')
    expect(out).toContain('<th style="text-align:left">a</th>')
    expect(out).toContain('<td style="text-align:right">2</td>')
    expect(out).toContain('type="checkbox"')
    expect(out).toContain('<blockquote>')
  })

  it('lets long inline code such as a hash break anywhere, but not short code', () => {
    const out = html('SHA256 `e37b59415702ef4be0383035a9ae1dc943dfd812537990c284b81956a9c19c5a` in `case/`, file `tudi详情采购清单ervice_jpg.exe`')
    expect(out).toContain('<code class="long">e37b5941')
    expect(out).toContain('<code>case/</code>')
    expect(out).toContain('<code>tudi详情采购清单ervice_jpg.exe</code>')
  })

  it('shows raw HTML as text instead of markup', () => {
    const out = html('<img src=x onerror=alert(1)>\n\nhi <script>alert(1)</script>')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<script')
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('drops unsafe link and image targets', () => {
    const out = html(
      '[a](javascript:alert(1)) [b](https://example.com) [c](data:text/html,x) ![i](https://evil.example/x.png) [r][ref]\n\n[ref]: vbscript:x',
    )
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('vbscript:')
    expect(out).not.toContain('data:text/html')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('rel="noopener noreferrer nofollow"')
    expect(out).not.toContain('<img')
  })

  it('renders code fences, math and mermaid source before their renderers load', () => {
    const out = html('```ts\nconst a = 1\n```\n\n$$\nx^2\n$$\n\n```mermaid\ngraph TD; A-->B\n```')
    expect(out).toContain('const a = 1')
    expect(out).toContain('x^2')
    expect(out).toContain('graph TD; A--&gt;B')
  })

  it('renders the same output whether or not the text is streaming', () => {
    const text = 'para one\n\n- a\n- b\n\n```js\nlet x\n\nlet y\n```\n\ntail **bo'
    expect(html(text, true)).toBe(html(text, false))
  })

  it('offers Preview next to links and code the web preview can frame', () => {
    const preview = {
      target: (href: string) =>
        previewTarget(href, { uiOrigin: 'http://127.0.0.1:4000', origins: [] }),
      open: () => {},
      label: 'Preview',
    }
    const out = renderToStaticMarkup(
      createElement(
        WebPreviewContext.Provider,
        { value: preview },
        createElement(Markdown, {
          text: 'Open http://localhost:5173/ or `http://127.0.0.1:8080` but not https://example.com or http://127.0.0.1:4000/api/info',
        }),
      ),
    )
    expect(out.match(/class="chipbtn link-preview"/g)).toHaveLength(2)
    expect(out).toContain('title="http://localhost:5173/"')
    expect(out).toContain('title="http://127.0.0.1:8080/"')
    expect(html('Open http://localhost:5173/')).not.toContain('link-preview')
  })
})

describe('normalizeMathDelimiters', () => {
  it('turns \\( \\) and \\[ \\] into dollar math outside code', () => {
    const text = [
      'Energy \\(E = mc^2\\) and',
      '\\[',
      '\\int_0^1 x\\,dx',
      '\\]',
      'keep `\\(code\\)` and',
      '```',
      '\\(fenced\\)',
      '```',
    ].join('\n')
    const out = normalizeMathDelimiters(text)
    expect(out).toContain('Energy $E = mc^2$ and')
    expect(out).toContain('$$\n\\int_0^1 x\\,dx\n$$')
    expect(out).toContain('`\\(code\\)`')
    expect(out).toContain('```\n\\(fenced\\)\n```')
  })

  it('renders them as math', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { text: 'inline \\(a^2\\)\n\n\\[b^2\\]' }),
    )
    expect(html).toContain('a^2')
    expect(html).toContain('b^2')
    expect(html).not.toContain('\\(')
    expect(html).not.toContain('\\[')
  })
})

describe('splitSettled', () => {
  it('cuts at the last blank line outside a code fence', () => {
    expect(splitSettled('a\n\nb')).toEqual({ settled: 'a\n\n', tail: 'b' })
    expect(splitSettled('a\n\n```\nx\n\ny')).toEqual({ settled: 'a\n\n', tail: '```\nx\n\ny' })
    expect(splitSettled('no break')).toEqual({ settled: '', tail: 'no break' })
  })
})

describe('safe URLs', () => {
  it('allows only http, https and mailto links', () => {
    expect(safeLinkHref('https://a.example/x')).toBe('https://a.example/x')
    expect(safeLinkHref('mailto:a@b.c')).toBe('mailto:a@b.c')
    expect(safeLinkHref('javascript:alert(1)')).toBeUndefined()
    expect(safeLinkHref(' JavaScript:alert(1)')).toBeUndefined()
    expect(safeLinkHref('/relative')).toBeUndefined()
  })

  it('allows only inline raster images and the file API', () => {
    expect(safeImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(safeImageSrc('data:image/svg+xml;base64,AAAA')).toBeUndefined()
    expect(safeImageSrc('/api/files/a.png')).toBe('/api/files/a.png')
    expect(safeImageSrc('/api/files/../x')).toBeUndefined()
    expect(safeImageSrc('https://evil.example/x.png')).toBeUndefined()
  })
})

describe('tool helpers', () => {
  it('summarizes a tool call by its key field', () => {
    expect(toolSummary('Bash', '{"command":"ls -la\\npwd"}')).toBe('ls -la')
    expect(toolSummary('Grep', '{"pattern":"foo","path":"src"}')).toBe('foo in src')
    // Message tools read as their text, not as JSON.
    expect(toolSummary('SubagentHandback', '{"message":"Status\\n1. done"}')).toBe('Status')
    expect(toolSummary('SendMessage', '{"to":"alice","summary":"ping","message":"hi"}')).toBe('→ alice · ping')
    expect(toolMessage('SubagentHandback', '{"message":"## Report"}')).toBe('## Report')
    expect(toolMessage('Bash', '{"message":"x"}')).toBeUndefined()
    expect(toolSummary('X', 'not json')).toBe('not json')
  })

  it('strips ANSI escapes and carriage returns', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m\r\nok\u001b]0;title\u0007')).toBe('red\nok')
  })
})
