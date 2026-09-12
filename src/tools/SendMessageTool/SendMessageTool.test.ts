import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import type { ToolUseContext } from '../../Tool.js'

const childFlag = 'CLAUDE_CODE_SEND_MESSAGE_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('SendMessage routing (isolated)', async () => {
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
  const configDir = await mkdtemp(join(tmpdir(), 'send-message-tool-'))
  afterAll(async () => {
    await rm(configDir, { recursive: true, force: true })
  })
  process.env.CLAUDE_CONFIG_DIR = configDir
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
    VERSION: 'test',
  }
  const resumeAgentBackground = mock(async () => ({
    outputFile: '/tmp/agent-output',
  }))
  mock.module('../AgentTool/resumeAgent.js', () => ({ resumeAgentBackground }))
  let endpoint: string | null = '/tmp/cc-socks/self.sock'
  const udsMessaging = await import('../../utils/udsMessaging.js')
  mock.module('../../utils/udsMessaging.js', () => ({
    ...udsMessaging,
    getUdsMessagingSocketPath: () => endpoint,
  }))
  const peer = {
    pid: 1234,
    sessionId: '22222222-2222-4222-8222-222222222222',
    cwd: '/tmp/other-project',
    startedAt: 1,
    name: 'researcher',
    ref: '222222',
    messagingSocketPath: '/tmp/cc-socks/peer.sock',
  }
  const resolvePeerSession = mock(async (to: string) =>
    [peer.name, `${peer.name} [${peer.ref}]`, peer.sessionId].includes(to)
      ? peer
      : undefined,
  )
  const sendToUdsSocket = mock(
    async (
      _socketPath: string,
      _message: string,
      _options?: { fromMode?: 'bypass' | 'prompting'; fromName?: string },
    ) => ({ msg_id: 'test-message-id' }),
  )
  mock.module('../../utils/udsClient.js', () => ({
    listAllLiveSessions: async () => [peer],
    resolvePeerSession,
    sendToUdsSocket,
  }))

  const { SendMessageTool } = await import('./SendMessageTool.js')
  const { getInboxPath, readMailbox } =
    await import('../../utils/teammateMailbox.js')
  const { writeTeamFileAsync } =
    await import('../../utils/swarm/teamHelpers.js')
  const { clearDynamicTeamContext } = await import('../../utils/teammate.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  let state = getDefaultAppState()
  const context = {
    getAppState: () => state,
    setAppState: (update: (prev: typeof state) => typeof state) => {
      state = update(state)
    },
  } as ToolUseContext

  beforeEach(() => {
    state = getDefaultAppState()
    clearDynamicTeamContext()
    endpoint = '/tmp/cc-socks/self.sock'
    resolvePeerSession.mockClear()
    sendToUdsSocket.mockClear()
    resumeAgentBackground.mockClear()
  })

  test('default registrations expose ListAgents and /list-agents without missing ListPeers', async () => {
    const { getAllBaseTools } = await import('../../tools.js')
    const names = getAllBaseTools().map(tool => tool.name)
    expect(names).toContain('SendMessage')
    expect(names).toContain('ListAgents')
    expect(names).not.toContain('ListPeers')
    const { builtInCommandNames } = await import('../../commands.js')
    expect(builtInCommandNames().has('list-agents')).toBe(true)
    expect(builtInCommandNames().has('peers')).toBe(true)
  })

  test('summary is optional for plain-text messages to agents, peers, and broadcasts', async () => {
    for (const to of ['researcher', 'peer [a1b2c3]', '*']) {
      const input = { to, message: 'hello' }
      expect(SendMessageTool.inputSchema.safeParse(input).success).toBe(true)
      expect(await SendMessageTool.validateInput!(input, context)).toEqual({
        result: true,
      })
    }
  })

  test('peer name, displayed ref, and session UUID route without a summary', async () => {
    for (const to of [
      peer.name,
      `${peer.name} [${peer.ref}]`,
      peer.sessionId,
    ]) {
      const input = { to, message: 'hello peer' }
      expect(await SendMessageTool.validateInput!(input, context)).toEqual({
        result: true,
      })
      const result = await SendMessageTool.call(
        input,
        context,
        async () => ({ behavior: 'allow' }),
        undefined,
      )
      expect(result.data.success).toBe(true)
      expect(sendToUdsSocket).toHaveBeenLastCalledWith(
        peer.messagingSocketPath,
        input.message,
        { fromMode: 'prompting' },
      )
      expect(existsSync(getInboxPath(to))).toBe(false)
    }
  })

  test('in-process agents take precedence over peers with the same name', async () => {
    const agentId = 'a0123456789abcdef'
    state = {
      ...state,
      agentNameRegistry: new Map([[peer.name, agentId]]),
      tasks: {
        [agentId]: {
          id: agentId,
          type: 'local_agent',
          status: 'running',
          pendingMessages: [],
        },
      },
    } as unknown as typeof state
    const result = await SendMessageTool.call(
      { to: peer.name, message: 'local hello' },
      context,
      async () => ({ behavior: 'allow' }),
      undefined,
    )
    expect(result.data.success).toBe(true)
    expect(state.tasks[agentId]).toMatchObject({
      pendingMessages: ['local hello'],
    })
    expect(resolvePeerSession).not.toHaveBeenCalled()
    expect(sendToUdsSocket).not.toHaveBeenCalled()
  })

  test('evicted registered agents still resume before peer resolution', async () => {
    state.agentNameRegistry.set(peer.name, 'a0123456789abcdef' as never)
    const result = await SendMessageTool.call(
      { to: peer.name, message: 'continue' },
      context,
      async () => ({ behavior: 'allow' }),
      undefined,
    )
    expect(result.data.success).toBe(true)
    expect(resumeAgentBackground).toHaveBeenCalledTimes(1)
    expect(resolvePeerSession).not.toHaveBeenCalled()
  })

  test('real Teams context routes members before peer resolution', async () => {
    const teamName = 'routing-team'
    await writeTeamFileAsync(teamName, {
      name: teamName,
      createdAt: 1,
      leadAgentId: 'lead',
      members: [
        {
          name: peer.name,
          agentId: 'teammate',
          joinedAt: 1,
          cwd: '/tmp',
          tmuxPaneId: '',
          subscriptions: [],
        },
      ],
    })
    state.teamContext = {
      teamName,
      leadAgentId: 'lead',
      teamFilePath: '',
      teammates: {},
    }
    const result = await SendMessageTool.call(
      { to: peer.name, message: 'team hello' },
      context,
      async () => ({ behavior: 'allow' }),
      undefined,
    )
    expect(result.data.success).toBe(true)
    expect((await readMailbox(peer.name, teamName))[0]?.text).toBe('team hello')
    expect(resolvePeerSession).not.toHaveBeenCalled()
    const unknown = await SendMessageTool.call(
      { to: 'missing-member', message: 'no mailbox' },
      context,
      async () => ({ behavior: 'allow' }),
      undefined,
    )
    expect(unknown.data.success).toBe(false)
    expect(existsSync(getInboxPath('missing-member', teamName))).toBe(false)
  })

  test('ambiguous peers return actionable resolver errors without mailbox fallback', async () => {
    resolvePeerSession.mockRejectedValueOnce(
      new Error(
        'Ambiguous peer researcher; use researcher [222222] or researcher [333333].',
      ),
    )
    const result = await SendMessageTool.call(
      { to: peer.name, message: 'hello' },
      context,
      async () => ({ behavior: 'allow' }),
      undefined,
    )
    expect(result.data.success).toBe(false)
    expect(result.data.message).toContain('researcher [333333]')
    expect(sendToUdsSocket).not.toHaveBeenCalled()
    expect(existsSync(getInboxPath(peer.name))).toBe(false)
  })

  test('structured messages are not sent to peers or phantom mailboxes', async () => {
    for (const to of [peer.name, 'missing-structured']) {
      const result = await SendMessageTool.call(
        { to, message: { type: 'shutdown_request' } },
        context,
        async () => ({ behavior: 'allow' }),
        undefined,
      )
      expect(result.data.success).toBe(false)
      expect(existsSync(getInboxPath(to))).toBe(false)
    }
    expect(sendToUdsSocket).not.toHaveBeenCalled()
  })

  test('direct socket replies carry permission class and require a local endpoint', async () => {
    state = {
      ...state,
      toolPermissionContext: {
        ...state.toolPermissionContext,
        mode: 'bypassPermissions',
      },
    }
    const input = { to: 'uds:/tmp/cc-socks/reply.sock', message: 'reply' }
    expect(
      (
        await SendMessageTool.call(
          input,
          context,
          async () => ({ behavior: 'allow' }),
          undefined,
        )
      ).data.success,
    ).toBe(true)
    expect(sendToUdsSocket).toHaveBeenLastCalledWith(
      '/tmp/cc-socks/reply.sock',
      'reply',
      { fromMode: 'bypass' },
    )
    state = {
      ...state,
      toolPermissionContext: {
        ...state.toolPermissionContext,
        mode: 'plan',
        isBypassPermissionsModeAvailable: true,
      },
    }
    for (const to of [input.to, peer.name]) {
      expect((await SendMessageTool.call(
        { ...input, to }, context, async () => ({ behavior: 'allow' }), undefined,
      )).data.success).toBe(true)
      expect(sendToUdsSocket.mock.calls.at(-1)?.[2]).toEqual({ fromMode: 'bypass' })
    }
    const sendsBeforeUnavailable = sendToUdsSocket.mock.calls.length
    endpoint = null
    const result = await SendMessageTool.call(
      input,
      context,
      async () => ({ behavior: 'allow' }),
      undefined,
    )
    expect(result.data.success).toBe(false)
    expect(sendToUdsSocket).toHaveBeenCalledTimes(sendsBeforeUnavailable)
  })

  test('bridge messaging stays unavailable and retains bypass-immune safetyCheck', async () => {
    const input = { to: 'bridge:session_123', message: 'hello' }
    const permission = await SendMessageTool.checkPermissions(input, context)
    expect(permission.behavior).toBe('ask')
    expect(permission.decisionReason).toMatchObject({
      type: 'safetyCheck',
      classifierApprovable: false,
    })
    expect(
      (
        await SendMessageTool.call(
          input,
          context,
          async () => ({ behavior: 'allow' }),
          undefined,
        )
      ).data.success,
    ).toBe(false)
    expect(sendToUdsSocket).not.toHaveBeenCalled()
  })

  test('prompt and schema only advertise local peers and optional summary', async () => {
    const prompt = await SendMessageTool.prompt({} as never)
    expect(prompt).toContain('ListAgents')
    expect(prompt).not.toMatch(/ListPeers|bridge:|Remote Control|will process|plan_approval|shutdown_request/)
    const schema = z.toJSONSchema(SendMessageTool.inputSchema)
    expect(schema.required).toEqual(['to', 'message'])
    expect(JSON.stringify(schema)).not.toMatch(
      /ListPeers|bridge:|Remote Control|required when message is a string|plan_approval|shutdown_request/,
    )
    expect(Buffer.byteLength(prompt + JSON.stringify(schema))).toBeLessThan(2000)
    expect(SendMessageTool.shouldDefer).toBe(true)
    expect(SendMessageTool.inputSchema.safeParse({
      to: 'peer', message: { type: 'shutdown_request' },
    }).success).toBe(false)
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    try {
      expect(SendMessageTool.inputSchema.safeParse({
        to: 'teammate', message: { type: 'shutdown_request' },
      }).success).toBe(true)
      expect(await SendMessageTool.prompt({} as never)).toContain('plan_approval_response')
    } finally {
      delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    }
  })

  test('local peer names and socket paths containing @ are valid recipients', async () => {
    for (const to of ['peer@local', 'uds:/tmp/cc-socks/peer@local.sock']) {
      expect(
        await SendMessageTool.validateInput!({ to, message: 'hello' }, context),
      ).toEqual({ result: true })
    }
  })

  test('SendMessage enables with IPC or existing Teams capability', () => {
    expect(SendMessageTool.isEnabled()).toBe(true)
    endpoint = null
    expect(SendMessageTool.isEnabled()).toBe(false)
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    try {
      expect(SendMessageTool.isEnabled()).toBe(true)
    } finally {
      delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    }
  })

  test('unknown recipients fail without creating a default-team mailbox', async () => {
    const result = await SendMessageTool.call(
      { to: 'missing-peer', message: 'hello', summary: 'say hello' },
      context,
      async () => ({ behavior: 'allow' }),
      undefined,
    )
    expect(result.data.success).toBe(false)
    expect(result.data.message).toContain('missing-peer')
    expect(existsSync(getInboxPath('missing-peer'))).toBe(false)
  })
}
