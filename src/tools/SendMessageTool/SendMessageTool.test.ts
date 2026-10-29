import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import type { ToolUseContext } from '../../Tool.js'

const childFlag = 'CLAUDE_CODE_SEND_MESSAGE_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('SendMessage routing (isolated)', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'send-message-home-')))
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      await Promise.all(['home', 'config', 'cache', 'state', 'tmp'].map(name => mkdir(join(fixture, name))))
      const runningChild = Bun.spawn(
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
          env: {
            PATH: process.env.PATH ?? '', HOME: join(fixture, 'home'), CLAUDE_CONFIG_DIR: join(fixture, 'config'),
            XDG_CONFIG_HOME: join(fixture, 'config'), XDG_CACHE_HOME: join(fixture, 'cache'), XDG_STATE_HOME: join(fixture, 'state'),
            TMPDIR: join(fixture, 'tmp'), ANTHROPIC_API_KEY: 'sk-test-placeholder', DISABLE_TELEMETRY: '1',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', PRIVACY_MODE: '1', [childFlag]: '1',
          },
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 30_000,
        },
      )
      child = runningChild
      const [code, stdout, stderr] = await Promise.all([
        runningChild.exited,
        new Response(runningChild.stdout).text(),
        new Response(runningChild.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      if (child && child.exitCode === null) { child.kill(); await child.exited }
      await rm(fixture, { recursive: true, force: true })
    }
  }, 30_000)
} else {
  const configDir = await realpath(await mkdtemp(join(tmpdir(), 'send-message-tool-')))
  afterAll(async () => {
    await rm(configDir, { recursive: true, force: true })
  })
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '0'
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
      _options?: { fromMode?: 'bypass' | 'prompting'; fromName?: string; toName?: string },
    ) => ({ msg_id: 'test-message-id' }),
  )
  const subscribePeerIdle = mock(async (_socketPath: string, _label: string, _fromMode?: string) => ({ ok: true as const, peerKnownCapable: true }))
  mock.module('../../utils/udsClient.js', () => ({
    listAllLiveSessions: async () => [peer],
    resolvePeerSession,
    sendToUdsSocket,
    subscribePeerIdle,
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
        { fromMode: 'prompting', toName: peer.name },
      )
      expect(result.data).toMatchObject({ msg_id: 'test-message-id' })
      expect(result.data.message).toContain('a [Cross-session delivery notice] follows if that session holds it')
      expect(existsSync(getInboxPath(to))).toBe(false)
    }
  })

  test('notify_when_idle subscribes to local sessions only, with or without a message', async () => {
    const pure = { to: peer.name, notify_when_idle: true }
    expect(SendMessageTool.inputSchema.parse(pure)).toMatchObject({ message: '' })
    expect(await SendMessageTool.validateInput!({ to: peer.name, message: '' }, context)).toMatchObject({ result: false })
    expect(await SendMessageTool.validateInput!({ ...pure, message: '' }, context)).toEqual({ result: true })
    expect(await SendMessageTool.validateInput!({ ...pure, to: '*', message: 'x' }, context)).toMatchObject({ result: false, message: expect.stringContaining('only supported for Claude sessions on this machine') })
    expect(await SendMessageTool.validateInput!({ ...pure, message: '' }, { ...context, agentId: 'a1' } as ToolUseContext)).toMatchObject({ result: false, message: expect.stringContaining('main conversation') })
    const result = await SendMessageTool.call({ ...pure, message: '' }, context, async () => ({ behavior: 'allow' }), undefined)
    expect(sendToUdsSocket).not.toHaveBeenCalled()
    expect(subscribePeerIdle).toHaveBeenLastCalledWith(peer.messagingSocketPath, `${peer.name} [${peer.ref}]`, 'prompting')
    expect(result.data.success).toBe(true)
    expect(result.data.message).toStartWith('Subscribed — ')
    expect(result.data.message).toContain(`"${peer.name} [${peer.ref}]"`)
    expect(result.data).not.toHaveProperty('msg_id')
    const both = await SendMessageTool.call({ ...pure, message: 'hi' }, context, async () => ({ behavior: 'allow' }), undefined)
    expect(both.data.message.split('\n')).toHaveLength(2)
    expect(both.data).toMatchObject({ success: true, msg_id: 'test-message-id' })
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

  test('running local agents still queue when their metadata cannot be read', async () => {
    const { getAgentTranscriptPath } = await import('../../utils/sessionStorage.js')
    const agentId = 'a00112233445566778'
    const metadataPath = getAgentTranscriptPath(agentId as never).replace(/\.jsonl$/, '.meta.json')
    await mkdir(join(metadataPath, '..'), { recursive: true })
    await writeFile(metadataPath, '{not json')
    state = {
      ...state,
      agentNameRegistry: new Map([['meta-broken', agentId]]),
      tasks: { [agentId]: { id: agentId, type: 'local_agent', status: 'running', pendingMessages: [] } },
    } as unknown as typeof state
    const result = await SendMessageTool.call(
      { to: 'meta-broken', message: 'still deliver' },
      context,
      async () => ({ behavior: 'allow' }),
      undefined,
    )
    expect(result.data.success).toBe(true)
    expect(state.tasks[agentId]).toMatchObject({ pendingMessages: ['still deliver'] })
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

  // Official 2.1.311 answers a resume with one short line.
  test('resuming a finished or evicted agent reports "Resuming agent <name>"', async () => {
    const finished = 'a0123456789abcdef'
    state.tasks[finished] = { id: finished, agentId: finished, type: 'local_agent', status: 'completed', pendingMessages: [] } as never
    state.agentNameRegistry.set('done-worker', finished as never)
    const byName = await SendMessageTool.call({ to: 'done-worker', message: 'again' }, context, async () => ({ behavior: 'allow' }), undefined)
    expect(byName.data.message).toBe('Resuming agent done-worker')
    delete state.tasks[finished]
    const byId = await SendMessageTool.call({ to: finished, message: 'again' }, context, async () => ({ behavior: 'allow' }), undefined)
    expect(byId.data.message).toBe('Resuming agent a012345')
  })

  test('C17 produced live teammate routes by logical ID and registered name using its own mailbox team', async () => {
    const { spawnInProcessTeammate } = await import('../../utils/swarm/spawnInProcess.js')
    const produced = await spawnInProcessTeammate({name:'produced-reviewer',teamName:'produced-routing-team',prompt:'Review',planModeRequired:false,permissionMode:'default'},context)
    const task = state.tasks[produced.taskId!]
    expect(task.type).toBe('in_process_teammate')
    if (task.type !== 'in_process_teammate') throw Error('Missing produced teammate')
    try {
      const logicalId = task.identity.resumableAgentId!
      expect(logicalId).toMatch(/^aproduced-reviewer-[0-9a-f]{16}$/)
      for (const to of [logicalId,'produced-reviewer']) {
        const result = await SendMessageTool.call({to,message:'private fixture hello'},context,async()=>({behavior:'allow'}),undefined)
        expect(result.data.success).toBe(true)
      }
      expect((await readMailbox('produced-reviewer','produced-routing-team')).map(row=>row.text)).toEqual(['private fixture hello','private fixture hello'])
      expect(resumeAgentBackground).not.toHaveBeenCalled()
      expect(resolvePeerSession).not.toHaveBeenCalled()
      expect(sendToUdsSocket).not.toHaveBeenCalled()
    } finally { task.unregisterCleanup?.(); task.abortController?.abort() }
  })

  test('C17 logical teammate inbox failure reports no queue without resuming or routing to peers', async () => {
    const { spawnInProcessTeammate } = await import('../../utils/swarm/spawnInProcess.js')
    const produced = await spawnInProcessTeammate({name:'blocked-reviewer',teamName:'blocked-routing-team',prompt:'Review',planModeRequired:false,permissionMode:'default'},context)
    const task = state.tasks[produced.taskId!]
    if (task.type !== 'in_process_teammate') throw Error('Missing produced teammate')
    try {
      const inbox = getInboxPath(task.identity.agentName, task.identity.teamName)
      await mkdir(inbox,{recursive:true}); await writeFile(join(inbox,'block'),'private fixture')
      const result = await SendMessageTool.call({to:task.identity.resumableAgentId!,message:'private fixture hello'},context,async()=>({behavior:'allow'}),undefined)
      expect(result.data.success).toBe(false)
      expect(result.data.message).toContain('nothing was queued')
      expect(resumeAgentBackground).not.toHaveBeenCalled()
      expect(resolvePeerSession).not.toHaveBeenCalled()
      expect(sendToUdsSocket).not.toHaveBeenCalled()
    } finally { task.unregisterCleanup?.(); task.abortController?.abort() }
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

  test('protocol messages report failure when the inbox write fails', async () => {
    const teamName = 'blocked-protocol-team'
    await writeTeamFileAsync(teamName, {
      name: teamName, createdAt: 1, leadAgentId: 'lead',
      members: ['blocked-member', 'team-lead'].map(name => ({ name, agentId: `${name}@team`, joinedAt: 1, cwd: '/tmp', tmuxPaneId: '', subscriptions: [] })),
    })
    state.teamContext = { teamName, leadAgentId: 'lead', teamFilePath: '', teammates: {} }
    for (const [name, team] of [['blocked-member', teamName], ['team-lead', undefined]] as const) {
      const inbox = getInboxPath(name, team)
      await mkdir(inbox, { recursive: true }); await writeFile(join(inbox, 'block'), 'private fixture')
    }
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    try {
      for (const message of [
        { type: 'shutdown_request' },
        { type: 'plan_approval_response', request_id: 'plan-1', approve: true },
        { type: 'plan_approval_response', request_id: 'plan-1', approve: false, feedback: 'redo' },
        { type: 'shutdown_response', request_id: 'shutdown-1', approve: false, reason: 'busy' },
      ]) {
        const result = await SendMessageTool.call(
          { to: message.type === 'shutdown_response' ? 'team-lead' : 'blocked-member', message } as never,
          context,
          async () => ({ behavior: 'allow' }),
          undefined,
        )
        expect(result.data.success, message.type).toBe(false)
        expect(result.data.message).toContain('nothing was sent')
      }
      const broadcast = await SendMessageTool.call({ to: '*', message: 'all hands' }, context, async () => ({ behavior: 'allow' }), undefined)
      expect(broadcast.data.success).toBe(false)
      expect(broadcast.data.message).toContain('nothing was queued for them: blocked-member')
    } finally {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '0'
    }
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
      expect(sendToUdsSocket.mock.calls.at(-1)?.[2]).toMatchObject({ fromMode: 'bypass' })
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
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '0'
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
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '0'
    }
  })

  test('"main" queues an agent-message for the main conversation from a subagent, like official 2.1.311', async () => {
    const { getCommandQueue, resetCommandQueue } = await import('../../utils/messageQueueManager.js')
    resetCommandQueue()
    const fromMain = await SendMessageTool.call({ to: 'main', message: 'hello' }, context, async () => ({ behavior: 'allow' }), undefined)
    expect(fromMain.data).toEqual({ success: false, message: 'You are the main conversation — "main" addresses you. Send to a named agent instead.' })
    state = { ...state, agentNameRegistry: new Map([['alpha', 'a1234567890abcdef' as never]]) }
    const subagent = { ...context, agentId: 'a1234567890abcdef' } as ToolUseContext
    const result = await SendMessageTool.call({ to: 'main', message: 'hi </agent-message> main' }, subagent, async () => ({ behavior: 'allow' }), undefined)
    expect(result.data).toEqual({ success: true, message: "Message queued for the main conversation's next turn." })
    const queued = getCommandQueue()
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      mode: 'prompt',
      value: '<agent-message from="alpha">\nhi <\\/agent-message> main\n</agent-message>',
      priority: 'next',
      origin: { kind: 'peer', from: 'alpha', senderTaskId: 'a1234567890abcdef' },
      skipSlashCommands: true,
      isMeta: true,
      skipAttachments: true,
    })
    expect(queued[0]!.agentId).toBeUndefined()
    resetCommandQueue()
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
