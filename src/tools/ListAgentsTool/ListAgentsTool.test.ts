import { expect, mock, test } from 'bun:test'
import { isValidElement, type ReactNode } from 'react'

const childFlag = 'CLAUDE_CODE_LIST_AGENTS_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('ListAgents discovery and presentation (isolated)', async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        'test',
        '--feature=UDS_INBOX',
        '--timeout',
        '30000',
        import.meta.path,
      ],
      {
        cwd: import.meta.dir,
        env: { ...process.env, [childFlag]: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
  }, 30_000)
} else {
  test('recovery builds enable the local IPC feature by default', async () => {
    delete process.env.CLAUDE_CODE_RECOVER_FEATURES
    const { feature } = await import('../../../scripts/shims/bun-bundle.js')
    expect(feature('UDS_INBOX')).toBe(true)
  })

  const peers = [
    {
      pid: 1234,
      sessionId: '22222222-2222-4222-8222-222222222222',
      cwd: '/tmp/other-project',
      startedAt: Date.now() - 1000,
      name: 'researcher',
      ref: '222222',
      messagingSocketPath: '/tmp/cc-socks/peer.sock',
      status: 'idle',
    },
  ]
  mock.module('../../utils/udsClient.js', () => ({
    listAllLiveSessions: async () => peers,
  }))
  let endpoint: string | null = '/tmp/cc-socks/self.sock'
  mock.module('../../utils/udsMessaging.js', () => ({
    getUdsMessagingSocketPath: () => endpoint,
  }))
  const { ListAgentsTool, formatAgentListing, listSubagents, listTeammates } = await import('./ListAgentsTool.js')
  const appState = { tasks: {}, agentNameRegistry: new Map(), teamContext: undefined }
  const context = { getAppState: () => appState } as never

  test('is a read-only discovery tool with an empty strict input schema', async () => {
    expect(ListAgentsTool.name).toBe('ListAgents')
    expect(ListAgentsTool.isReadOnly()).toBe(true)
    expect(ListAgentsTool.isConcurrencySafe()).toBe(true)
    expect(ListAgentsTool.inputSchema.safeParse({}).success).toBe(true)
    expect(ListAgentsTool.inputSchema.safeParse({ remote: true }).success).toBe(
      false,
    )
    const result = await ListAgentsTool.call({}, context)
    expect(result.data.agents).toEqual(peers)
    expect(result.data.listing).toContain('Peer sessions (1):\n  researcher [222222]  ·  idle  ·  started')
    expect(ListAgentsTool.isEnabled()).toBe(true)
    endpoint = null
    expect(ListAgentsTool.isEnabled()).toBe(false)
    endpoint = '/tmp/cc-socks/self.sock'
  })

  test('/list-agents uses the same discovery and safe Text presentation as the tool', async () => {
    const { default: command } = await import('../../commands/peers/index.js')
    expect(command.name).toBe('list-agents')
    expect(command.type).toBe('local-jsx')
    const onDone = mock(() => {})
    const page = await (await command.load()).call(onDone)
    const toolResult = await ListAgentsTool.call({}, context)
    const toolNode = ListAgentsTool.renderToolResultMessage(toolResult.data)
    const texts = (node: ReactNode): string => {
      if (node === null || node === undefined || typeof node === 'boolean')
        return ''
      if (Array.isArray(node)) return node.map(texts).join('')
      if (typeof node === 'string' || typeof node === 'number')
        return String(node)
      if (isValidElement<{ children?: ReactNode }>(node))
        return texts(node.props.children)
      throw new Error('Unexpected presentation node')
    }
    expect(isValidElement<{ agents: unknown[] }>(page)).toBe(true)
    expect((page as { props: { agents: unknown[] } }).props.agents).toEqual(
      toolResult.data.agents,
    )
    const { AgentList } = await import('./UI.js')
    expect(isValidElement(toolNode) && toolNode.type).toBe(AgentList)
    const rendered = AgentList({ agents: peers })
    expect(texts(rendered)).toContain('researcher [222222]')
    expect(texts(rendered)).toContain('/tmp/other-project')
    expect(texts(rendered)).toContain('[idle]')
    const dirty = AgentList({
      agents: [
        {
          ...peers[0]!,
          name: '\u001b[31mpeer\u001b[0m\r\nforged',
          cwd: '/tmp/\u0007project',
        },
      ],
    })
    expect(texts(dirty)).not.toMatch(/\p{Cc}/u)
    expect(texts(dirty)).toContain('peer  forged')
    expect(onDone).not.toHaveBeenCalled()
    const dialogPage = page as { props: { onDone: () => void } }
    dialogPage.props.onDone()
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(texts(AgentList({ agents: [] }))).toContain(
      'No other live local Claude sessions found.',
    )
    const block = ListAgentsTool.mapToolResultToToolResultBlockParam(
      toolResult.data,
      'tool-use-id',
    )
    expect(block.content).toBe(toolResult.data.listing)
    const prompt = await ListAgentsTool.prompt()
    expect(prompt).toContain('SendMessage')
    expect(prompt).not.toMatch(/bridge|Remote Control|shutdown|approval/)
  })

  test('listing names this session and groups subagents, teammates and peers like official', () => {
    const now = 1_000_000
    const state = {
      agentNameRegistry: new Map([['reviewer', 'a1b2c3d4']]),
      tasks: {
        a1b2c3d4: { id: 'a1b2c3d4', type: 'local_agent', agentType: 'general-purpose', status: 'running', startTime: now - 5000 },
        main: { id: 'main', type: 'local_agent', agentType: 'main-session', status: 'running', startTime: now },
        t1: { id: 't1', type: 'in_process_teammate', identity: { agentId: 'tm-1' }, isIdle: true, status: 'running' },
      },
      teamContext: {
        teamName: 'team', teamFilePath: '/tmp/team.json', leadAgentId: 'lead',
        teammates: {
          lead: { name: 'team-lead', tmuxSessionName: '', tmuxPaneId: 'leader', cwd: '/', spawnedAt: now },
          'tm-1': { name: 'tester', agentType: 'qa', tmuxSessionName: '', tmuxPaneId: 'in-process', cwd: '/', spawnedAt: now - 60000 },
        },
      },
    } as never
    const listing = formatAgentListing(
      { name: 'alpha', ref: '2dd6d5' },
      listSubagents(state),
      listTeammates(state),
      [{ ...peers[0]!, kind: 'interactive', startedAt: now - 35000 }],
      now,
    )
    expect(listing).toBe([
      'This session is alpha [2dd6d5] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).',
      '',
      'Subagents (1):\n  reviewer [a1b2c3d4]  ·  general-purpose  ·  running  ·  started 5s ago',
      '',
      'Teammates (1):\n  tester  ·  qa  ·  idle  ·  started 1m ago',
      '',
      'Peer sessions (1):\n  researcher [222222]  ·  interactive  ·  idle  ·  started 35s ago',
    ].join('\n'))
    expect(formatAgentListing({ name: 'alpha', ref: '2dd6d5' }, [], [], [], now)).toContain('No reachable agents — no other Claude session is running on this machine right now')
  })
}
