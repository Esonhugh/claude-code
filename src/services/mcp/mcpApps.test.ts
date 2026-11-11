import { afterEach, describe, expect, test } from 'bun:test'
import {
  isMcpAppResource,
  isToolHiddenFromModel,
  mcpAppsClientExtensions,
  toolUiMeta,
} from './mcpApps.js'

describe('mcpAppsClientExtensions', () => {
  const saved = process.env.CLAUDE_CODE_MCP_APPS_HOST
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_MCP_APPS_HOST
    else process.env.CLAUDE_CODE_MCP_APPS_HOST = saved
  })

  test('offers the UI extension only for a host', () => {
    delete process.env.CLAUDE_CODE_MCP_APPS_HOST
    expect(mcpAppsClientExtensions()).toBeUndefined()
    process.env.CLAUDE_CODE_MCP_APPS_HOST = '1'
    expect(mcpAppsClientExtensions()).toEqual({
      'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
    })
  })
})

describe('toolUiMeta', () => {
  test('keeps the ui members and drops every other _meta key', () => {
    expect(
      toolUiMeta({
        ui: { resourceUri: 'ui://srv/w.html', visibility: ['model', 'app'] },
        'anthropic/searchHint': 'x',
      }),
    ).toEqual({ ui: { resourceUri: 'ui://srv/w.html', visibility: ['model', 'app'] } })
    expect(toolUiMeta({ 'anthropic/searchHint': 'x' })).toBeUndefined()
    expect(toolUiMeta(undefined)).toBeUndefined()
  })

  test('keeps the deprecated flat ui/resourceUri', () => {
    expect(toolUiMeta({ 'ui/resourceUri': 'ui://srv/a' })).toEqual({ 'ui/resourceUri': 'ui://srv/a' })
    expect(toolUiMeta({ 'ui/resourceUri': 'https://evil' })).toBeUndefined()
  })

  test('an invalid ui still passes on its visibility', () => {
    expect(toolUiMeta({ ui: { resourceUri: 'https://x', visibility: ['app'] } })).toEqual({
      ui: { visibility: ['app'] },
    })
    expect(toolUiMeta({ ui: 'nope' })).toEqual({ ui: { visibility: [] } })
    expect(toolUiMeta({ ui: { resourceUri: `ui://${'a'.repeat(5000)}` } })).toBeUndefined()
  })
})

describe('isToolHiddenFromModel', () => {
  test('hides a tool whose visibility leaves out model', () => {
    expect(isToolHiddenFromModel({ ui: { visibility: ['app'] } })).toBe(true)
    expect(isToolHiddenFromModel({ ui: { visibility: [] } })).toBe(true)
    expect(isToolHiddenFromModel({ ui: 'bad' })).toBe(true)
  })

  test('keeps a tool that declares model or no visibility', () => {
    expect(isToolHiddenFromModel({ ui: { visibility: ['model', 'app'] } })).toBe(false)
    expect(isToolHiddenFromModel({ ui: { resourceUri: 'ui://a' } })).toBe(false)
    expect(isToolHiddenFromModel({ ui: null })).toBe(false)
    expect(isToolHiddenFromModel(undefined)).toBe(false)
  })
})

describe('isMcpAppResource', () => {
  test('matches ui:// URIs and the mcp-app HTML profile', () => {
    expect(isMcpAppResource({ uri: 'ui://srv/w.html' })).toBe(true)
    expect(isMcpAppResource({ uri: 'UI://srv/w.html' })).toBe(true)
    expect(isMcpAppResource({ uri: 'https://a', mimeType: 'text/html;profile=mcp-app' })).toBe(true)
    expect(isMcpAppResource({ uri: 'https://a', mimeType: 'Text/HTML; charset=utf-8; profile="mcp-app"' })).toBe(true)
  })

  test('leaves other resources in the list', () => {
    expect(isMcpAppResource({ uri: 'file:///notes.txt', mimeType: 'text/plain' })).toBe(false)
    expect(isMcpAppResource({ uri: 'https://a', mimeType: 'text/html' })).toBe(false)
    expect(isMcpAppResource({ uri: 'https://a', mimeType: 'text/plain;profile=mcp-app' })).toBe(false)
  })
})
