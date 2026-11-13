import { describe, expect, test } from 'bun:test'
import { appCsp, appTools, callToolResult, findAppTool, openableLink, resourceHtml, withCsp } from './mcpApps'

const status = {
  mcpServers: [
    {
      name: 'my.srv',
      status: 'connected',
      tools: [
        { name: 'show', _meta: { ui: { resourceUri: 'ui://srv/w.html' } } },
        { name: 'refresh', annotations: { readOnly: true }, _meta: { ui: { resourceUri: 'ui://srv/w.html', visibility: ['app'] } } },
        { name: 'legacy', _meta: { 'ui/resourceUri': 'ui://srv/old.html' } },
        { name: 'plain', annotations: { readOnly: true } },
        { name: 'bad', _meta: { ui: { resourceUri: 'https://evil' } } },
      ],
    },
    { name: 'down', status: 'failed', tools: [{ name: 'x', _meta: { ui: { resourceUri: 'ui://a' } } }] },
  ],
}

describe('appTools', () => {
  test('lists every connected tool, with the ui:// resource of those that name one', () => {
    const tools = appTools(status)
    expect(tools.map(t => t.toolName)).toEqual(['show', 'refresh', 'legacy', 'plain', 'bad'])
    expect(tools.filter(t => t.resourceUri).map(t => t.toolName)).toEqual(['show', 'refresh', 'legacy'])
    expect(tools[0]).toMatchObject({ serverName: 'my.srv', modelVisible: true, appVisible: true, readOnly: false })
    expect(tools[1]).toMatchObject({ modelVisible: false, appVisible: true, readOnly: true })
    expect(tools[2]!.resourceUri).toBe('ui://srv/old.html')
    // An app may call a read-only tool without a UI of its own without asking the user.
    expect(tools[3]).toMatchObject({ toolName: 'plain', modelVisible: true, readOnly: true })
  })

  test('matches a chat tool call by its normalized name', () => {
    const tools = appTools(status)
    expect(findAppTool(tools, 'mcp__my_srv__show')?.toolName).toBe('show')
    expect(findAppTool(tools, 'mcp__my_srv__plain')).toBeUndefined()
    expect(findAppTool(tools, 'mcp__my_srv__bad')).toBeUndefined()
  })

  test('finds no app when two servers share the chat name', () => {
    const tool = { toolName: 'show', resourceUri: 'ui://x/w.html', modelVisible: true, appVisible: true, readOnly: false }
    const both = [{ ...tool, serverName: 'a.b' }, { ...tool, serverName: 'a_b' }]
    expect(findAppTool(both, 'mcp__a_b__show')).toBeUndefined()
    expect(findAppTool(both.slice(1), 'mcp__a_b__show')?.serverName).toBe('a_b')
  })
})

describe('appCsp', () => {
  test('reaches no network without a declared csp', () => {
    const csp = appCsp(undefined)
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("script-src 'unsafe-inline'")
  })

  test('takes declared origins and drops anything that could break out of the policy', () => {
    const csp = appCsp({
      ui: { csp: { connectDomains: ['https://api.example.com', "https://x; script-src *", "'unsafe-eval'"], resourceDomains: ['https://*.cdn.example.com'] } },
    })
    expect(csp).toContain('connect-src https://api.example.com;')
    expect(csp).toContain("script-src 'unsafe-inline' https://*.cdn.example.com")
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toContain('script-src *')
  })
})

test('withCsp puts the policy before the app markup', () => {
  const html = withCsp('<!DOCTYPE html><html><script>x()</script></html>', `default-src 'none'`)
  expect(html.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'">`)).toBe(true)
  expect(html).not.toContain('<!DOCTYPE html>')
})

test('resourceHtml reads text and base64 contents', () => {
  expect(resourceHtml({ contents: [{ uri: 'ui://a', text: '<p>hi</p>', _meta: { ui: { prefersBorder: true } } }] })).toEqual({
    html: '<p>hi</p>',
    meta: { ui: { prefersBorder: true } },
  })
  expect(resourceHtml({ contents: [{ uri: 'ui://a', blob: btoa('<b>x</b>') }] })?.html).toBe('<b>x</b>')
  expect(resourceHtml({ contents: [] })).toBeUndefined()
})

test('openableLink allows only http(s)', () => {
  expect(openableLink('https://example.com/a')).toBe('https://example.com/a')
  expect(openableLink('javascript:alert(1)')).toBeUndefined()
  expect(openableLink(3)).toBeUndefined()
})

test('callToolResult turns the CLI reply into MCP content blocks', () => {
  expect(callToolResult({ content: 'data 42', structuredContent: { n: 42 } })).toEqual({
    content: [{ type: 'text', text: 'data 42' }],
    structuredContent: { n: 42 },
  })
  expect(
    callToolResult({
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      ],
    }).content,
  ).toEqual([
    { type: 'text', text: 'a' },
    { type: 'image', data: 'AAA', mimeType: 'image/png' },
  ])
})
