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
  const { ListAgentsTool } = await import('./ListAgentsTool.js')

  test('is a read-only discovery tool with an empty strict input schema', async () => {
    expect(ListAgentsTool.name).toBe('ListAgents')
    expect(ListAgentsTool.isReadOnly()).toBe(true)
    expect(ListAgentsTool.isConcurrencySafe()).toBe(true)
    expect(ListAgentsTool.inputSchema.safeParse({}).success).toBe(true)
    expect(ListAgentsTool.inputSchema.safeParse({ remote: true }).success).toBe(
      false,
    )
    expect(await ListAgentsTool.call()).toEqual({ data: { agents: peers } })
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
    const toolResult = await ListAgentsTool.call()
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
    expect(JSON.parse(String(block.content)).agents[0].ref).toBe('222222')
    const prompt = await ListAgentsTool.prompt()
    expect(prompt).toContain('SendMessage')
    expect(prompt).not.toMatch(/bridge|Remote Control|shutdown|approval/)
  })
}
