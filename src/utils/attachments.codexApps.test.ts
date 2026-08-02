import { describe, expect, test } from 'bun:test'
import type { ConnectedMCPServer } from '../services/mcp/types.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import {
  extractAtMentionedFiles,
  extractMcpResourceMentions,
  getAttachments,
} from './attachments.js'
import { FileStateCache } from './fileStateCache.js'

describe('@codex-app mentions', () => {
  test('are not treated as files or MCP resources', () => {
    const input = 'Use @codex-app:github to inspect the pull request'

    expect(extractAtMentionedFiles(input)).toEqual([])
    expect(extractMcpResourceMentions(input)).toEqual([])
  })
})

function connectedClient(
  name: string,
  extensions: Record<string, object>,
  onRead: () => void,
): ConnectedMCPServer {
  return {
    client: {
      async readResource({ uri }: { uri: string }) {
        onRead()
        return { contents: [{ uri, text: '# Resource' }] }
      },
    } as ConnectedMCPServer['client'],
    name,
    type: 'connected',
    capabilities: { resources: {}, extensions },
    config: {
      type: 'http',
      url: 'https://example.com/mcp',
      scope: 'user',
    },
    cleanup: async () => {},
  }
}

function attachmentContext(client: ConnectedMCPServer, uri: string) {
  const appState = getDefaultAppState()
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-sonnet-4-6',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [client],
      mcpResources: {
        [client.name]: [{ server: client.name, uri, name: 'SKILL.md' }],
      },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: new AbortController(),
    readFileState: new FileStateCache(8, 8 * 1024),
    messages: [],
    getAppState: () => appState,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as never
}

describe('@MCP SKILL.md mentions', () => {
  const uri = 'skill://docs/example/SKILL.md'

  test('keep ordinary generic resources available without the skills extension', async () => {
    let reads = 0
    const client = connectedClient('ordinary', {}, () => reads++)

    const attachments = await getAttachments(
      `Read @ordinary:${uri}`,
      attachmentContext(client, uri),
      null,
      [],
    )

    expect(attachments.filter(attachment => attachment.type === 'mcp_resource')).toHaveLength(1)
    expect(reads).toBe(1)
  })

  test('do not preload SKILL.md from servers that declare the skills extension', async () => {
    let reads = 0
    const client = connectedClient(
      'skills',
      { 'io.modelcontextprotocol/skills': {} },
      () => reads++,
    )

    const attachments = await getAttachments(
      `Read @skills:${uri}`,
      attachmentContext(client, uri),
      null,
      [],
    )

    expect(attachments.filter(attachment => attachment.type === 'mcp_resource')).toHaveLength(0)
    expect(reads).toBe(0)
  })
})
