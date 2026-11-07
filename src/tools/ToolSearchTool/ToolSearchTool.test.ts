import { describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
  ISSUES_EXPLAINER: 'report an issue',
}

const { ToolSearchTool } = await import('./ToolSearchTool.js')

const appTool = {
  name: 'mcp__codex_apps__github__add_issue_labels',
  isMcp: true,
  mcpInfo: { serverName: 'codex_apps', toolName: 'github__add_issue_labels' },
  async prompt() {
    return 'Add labels to a GitHub issue'
  },
} as never
const webFetch = {
  name: 'WebFetch',
  shouldDefer: true,
  searchHint: 'fetch a url, github pages',
  async prompt() {
    return 'Fetch a URL'
  },
} as never

function searchWhilePending(serverName: string, settleAfterMs: number) {
  let settled = false
  setTimeout(() => {
    settled = true
  }, settleAfterMs)
  const permissionContext = getEmptyToolPermissionContext()
  return ToolSearchTool.call(
    { query: 'github', max_results: 5 },
    {
      options: {
        tools: [webFetch],
        refreshTools: () => (settled ? [webFetch, appTool] : [webFetch]),
        agentDefinitions: { activeAgents: [] },
      },
      getAppState: () => ({
        mcp: {
          clients: [{ name: serverName, type: settled ? 'connected' : 'pending' }],
        },
        toolPermissionContext: permissionContext,
      }),
      abortController: new AbortController(),
    } as never,
    async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
  )
}

describe('ToolSearch with Codex Apps connecting in the background', () => {
  test('waits for pending Codex Apps servers before searching', async () => {
    const result = await searchWhilePending('codex_apps', 300)
    expect(result.data.matches).toContain(
      'mcp__codex_apps__github__add_issue_labels',
    )
  })

  test('does not wait for other pending MCP servers', async () => {
    const started = Date.now()
    const result = await searchWhilePending('slow_server', 300)
    expect(Date.now() - started).toBeLessThan(250)
    expect(result.data.matches).not.toContain(
      'mcp__codex_apps__github__add_issue_labels',
    )
  })
})
