import { expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QueryParams } from '../../query.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'

const childEnv = 'CLAUDE_CODE_TEAMMATE_RESUME_TEST_CHILD'
if (process.env[childEnv] !== '1') {
  test('SendMessage restores produced teammates in an isolated process', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'teammate-resume-config-')))
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      await Promise.all(['home', 'config', 'cache', 'state', 'tmp'].map(name => mkdir(join(fixture, name))))
      const runningChild = Bun.spawn([process.execPath, 'test', '--timeout', '30000', import.meta.path], {
        cwd: import.meta.dir,
        env: {
          PATH: process.env.PATH ?? '', HOME: join(fixture, 'home'), CLAUDE_CONFIG_DIR: join(fixture, 'config'),
          XDG_CONFIG_HOME: join(fixture, 'config'), XDG_CACHE_HOME: join(fixture, 'cache'), XDG_STATE_HOME: join(fixture, 'state'),
          TMPDIR: join(fixture, 'tmp'), DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', PRIVACY_MODE: '1',
          [childEnv]: '1',
        },
        stdout: 'pipe', stderr: 'pipe', timeout: 60000,
      })
      child = runningChild
      const [code, stdout, stderr] = await Promise.all([runningChild.exited, new Response(runningChild.stdout).text(), new Response(runningChild.stderr).text()])
      if (code !== 0) throw Error(`Isolated teammate resume failed (${code})\n${stdout}\n${stderr}`)
      expect(`${stdout}\n${stderr}`).toContain('teammate resume production complete')
      expect(code).toBe(0)
    } finally {
      if (child && child.exitCode === null) { child.kill(); await child.exited }
      await rm(fixture, { recursive: true, force: true })
    }
  }, 65000)
} else {
  await isolatedTests()
}

async function isolatedTests() {
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
  const filesystem = await import('fs/promises')
  const originalWriteFile = filesystem.writeFile, originalOpen = filesystem.open
  let metadataBarrier: { path: string; started: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | undefined
  mock.module('fs/promises', () => ({
    ...filesystem,
    async writeFile(...args: Parameters<typeof filesystem.writeFile>) {
      const path = String(args[0]), barrier = metadataBarrier
      if (!barrier || (path !== barrier.path && !path.startsWith(barrier.path + '.'))) return originalWriteFile(...args)
      metadataBarrier = undefined
      if (typeof args[1] !== 'string') throw Error('Metadata writes must serialize JSON as text')
      const options = typeof args[2] === 'object' ? args[2] : { encoding: args[2] }
      const handle = await originalOpen(path, options?.flag ?? 'w', options?.mode)
      try { barrier.started.resolve(); await barrier.release.promise; await handle.writeFile(args[1], args[2]) }
      finally { await handle.close() }
    },
  }))
  const observed: QueryParams[] = []
  let replyText = 'real runner reply'
  let queryGate: Promise<void> | undefined
  let afterReply: ((params: QueryParams) => void) | undefined
  let ordinaryCalls = 0
  mock.module('../../query.js', () => ({
    async *query(params: QueryParams) {
      observed.push({ ...params, messages: params.messages.slice(), toolUseContext: { ...params.toolUseContext, options: { ...params.toolUseContext.options, tools: params.toolUseContext.options.tools.slice() } } })
      if (queryGate) await queryGate
      yield createAssistantMessage({ content: replyText })
      afterReply?.(params)
      return { reason: 'completed' }
    },
  }))
  mock.module('../../tools/AgentTool/resumeAgent.js', () => ({
    resumeAgentBackground: async () => { ordinaryCalls++; throw Error('Ordinary resume is not a teammate transport') },
  }))
  const promptsModule = await import('../../constants/prompts.js')
  mock.module('../../constants/prompts.js', () => ({ ...promptsModule, getSystemPrompt: async () => asSystemPrompt(['deterministic core']) }))
  const { asSystemPrompt } = await import('../systemPromptType.js')
  const { createAssistantMessage } = await import('../messages.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createFileStateCacheWithSizeLimit } = await import('../fileStateCache.js')
  const { switchSession, getSessionId, getSessionProjectDir } = await import('../../bootstrap/state.js')
  const { asSessionId, asAgentId } = await import('../../types/ids.js')
  const { spawnInProcessTeammate } = await import('./spawnInProcess.js')
  const { runInProcessTeammate } = await import('./inProcessRunner.js')
  const { readAgentMetadata, getAgentTranscript, getAgentTranscriptPath, flushSessionStorage, writeAgentMetadata } = await import('../sessionStorage.js')
  const { parseAgentsFromJson, parseAgentFromMarkdown } = await import('../../tools/AgentTool/loadAgentsDir.js')
  const { GENERAL_PURPOSE_AGENT } = await import('../../tools/AgentTool/built-in/generalPurposeAgent.js')
  const { SendMessageTool } = await import('../../tools/SendMessageTool/SendMessageTool.js')
  const { BashTool } = await import('../../tools/BashTool/BashTool.js')
  const { readMailbox, writeToMailbox, getInboxPath } = await import('../teammateMailbox.js')
  const { writeTeamFileAsync, readTeamFileAsync } = await import('./teamHelpers.js')
  const { runWithTeammateContext, createTeammateContext } = await import('../teammateContext.js')
  const { saveGlobalConfig, getGlobalConfig } = await import('../config.js')
  const { resetGitFileWatcher } = await import('../git/gitFilesystem.js')
  const previousSession = getSessionId(), previousProject = getSessionProjectDir()
  const fixture = await mkdtemp(join(tmpdir(), 'teammate-resume-'))
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  switchSession(asSessionId(crypto.randomUUID()), join(fixture, 'project'))
  const contexts: ToolUseContext[] = []
  function definition(prompt = 'ORIGINAL_CUSTOM_INSTRUCTIONS') {
    return parseAgentsFromJson({ 'custom-reviewer': { description: 'Review current code', prompt, tools: ['*'] } })[0]!
  }
  function makeContext(active: AgentDefinition = definition()) {
    let state = getDefaultAppState()
    const context: ToolUseContext = {
      options: {
        commands: [], debug: false, mainLoopModel: 'claude-sonnet-4-6', tools: [SendMessageTool, BashTool], verbose: false,
        thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: false,
        agentDefinitions: { activeAgents: [active], allAgents: [active], allowedAgentTypes: undefined },
      },
      abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
      getAppState: () => state, setAppState: updater => { state = updater(state) }, setInProgressToolUseIDs: () => {},
      setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {}, messages: [],
    } as ToolUseContext
    contexts.push(context)
    return context
  }
  async function poll(predicate: () => boolean | Promise<boolean>, label: string) {
    for (let i = 0; i < 150; i++) { if (await predicate()) return; await Bun.sleep(10) }
    throw Error(`Did not settle: ${label}`)
  }
  function abortReply(context: ToolUseContext) {
    afterReply = params => {
      for (const task of Object.values(context.getAppState().tasks)) if (task.type === 'in_process_teammate' && task.status === 'running' && task.identity.resumableAgentId === params.toolUseContext.agentId) task.abortController?.abort()
    }
  }
  async function produce(context: ToolUseContext, { retain = false, planModeRequired = false, permissionMode = 'acceptEdits' as const } = {}) {
    const serial = contexts.indexOf(context)
    const name = `reviewer-${serial}`, teamName = `resume-team-${serial}`
    await writeTeamFileAsync(teamName, { name: teamName, createdAt: 1, leadAgentId: 'team-lead', members: [] })
    const spawned = await spawnInProcessTeammate({ name, teamName, prompt: 'original raw prompt', description: 'Original task', color: 'blue', planModeRequired, permissionMode, model: 'claude-sonnet-4-6' }, context)
    if (!spawned.identity?.resumableAgentId || !spawned.taskId || !spawned.abortController || !spawned.teammateContext) throw Error('Missing produced identity')
    if (retain) context.setAppState(state => ({ ...state, viewingAgentTaskId: spawned.taskId }))
    abortReply(context)
    await runInProcessTeammate({ identity: spawned.identity, taskId: spawned.taskId, prompt: 'original raw prompt', description: 'Original task', model: 'claude-sonnet-4-6', effort: 'low', agentDefinition: context.options.agentDefinitions.activeAgents[0], teammateContext: spawned.teammateContext, toolUseContext: context, abortController: spawned.abortController })
    const id = asAgentId(spawned.identity.resumableAgentId)
    await flushSessionStorage()
    await poll(async () => (await readAgentMetadata(id)) !== null, 'metadata')
    const transcript = await getAgentTranscript(id)
    expect(transcript?.messages.map(message => message.type)).toEqual(['user', 'assistant'])
    expect(context.getAppState().agentNameRegistry.get(name)).toBe(id)
    expect(!!context.getAppState().tasks[spawned.taskId]).toBe(retain)
    return { id, name, teamName, taskId: spawned.taskId, transcript: transcript! }
  }
  async function send(context: ToolUseContext, to: string, message = 'new raw prompt') {
    return SendMessageTool.call({ to, message }, context, async () => ({ behavior: 'allow' }), undefined)
  }
  async function finishResume(context: ToolUseContext, id: ReturnType<typeof asAgentId>, previousQueries: number) {
    await poll(() => observed.length > previousQueries, 'resumed query')
    await poll(() => !Object.values(context.getAppState().tasks).some(task => task.type === 'in_process_teammate' && task.status === 'running' && task.identity.resumableAgentId === id), 'resumed loop')
    await flushSessionStorage()
    return observed.at(-1)!
  }
  test('actual metadata replacement never publishes an empty or partial sidecar to concurrent readers', async () => {
    const context = makeContext()
    const spawned = await spawnInProcessTeammate({ name: 'atomic-metadata', teamName: 'metadata-atomic-team', prompt: 'inspect', planModeRequired: false }, context)
    if (!spawned.identity?.resumableAgentId || !spawned.abortController) throw Error('No produced logical identity')
    spawned.abortController.abort()
    const id = asAgentId(spawned.identity.resumableAgentId)
    await writeAgentMetadata(id, { agentType: 'atomic-reviewer', description: 'initial' })
    const barrier = { path: getAgentTranscriptPath(id).replace(/\.jsonl$/, '.meta.json'), started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
    metadataBarrier = barrier
    const update = writeAgentMetadata(id, { agentType: 'atomic-reviewer', description: 'updated' })
    await barrier.started.promise
    let settled = false
    const reading = readAgentMetadata(id).finally(() => { settled = true })
    try {
      await Bun.sleep(10)
      expect(settled).toBe(false)
      expect(JSON.parse(await readFile(barrier.path, 'utf8'))).toEqual({ agentType: 'atomic-reviewer', description: 'initial' })
    } finally { barrier.release.resolve(); await update; metadataBarrier = undefined }
    expect(await reading).toEqual({ agentType: 'atomic-reviewer', description: 'updated' })
    expect(await readAgentMetadata(id)).toEqual({ agentType: 'atomic-reviewer', description: 'updated' })
  })
  test('real metadata writes serialize per sidecar so earlier completion cannot overwrite the latest mode', async () => {
    const context = makeContext()
    const spawned = await spawnInProcessTeammate({ name: 'ordered-metadata', teamName: 'metadata-order-team', prompt: 'inspect', planModeRequired: false }, context)
    if (!spawned.identity?.resumableAgentId || !spawned.abortController) throw Error('No produced logical identity')
    spawned.abortController.abort()
    const id = asAgentId(spawned.identity.resumableAgentId)
    await writeAgentMetadata(id, { agentType: 'ordered-reviewer', permissionMode: 'default' })
    const barrier = { path: getAgentTranscriptPath(id).replace(/\.jsonl$/, '.meta.json'), started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
    metadataBarrier = barrier
    const first = writeAgentMetadata(id, { agentType: 'ordered-reviewer', permissionMode: 'acceptEdits' })
    await barrier.started.promise
    const last = writeAgentMetadata(id, { agentType: 'ordered-reviewer', permissionMode: 'plan' })
    let settled = false
    const reading = readAgentMetadata(id).finally(() => { settled = true })
    try {
      await Bun.sleep(10)
      expect(settled).toBe(false)
      expect(JSON.parse(await readFile(barrier.path, 'utf8'))).toEqual({ agentType: 'ordered-reviewer', permissionMode: 'default' })
    }
    finally { barrier.release.resolve(); await Promise.all([first, last]); metadataBarrier = undefined }
    expect(await reading).toEqual({ agentType: 'ordered-reviewer', permissionMode: 'plan' })
    expect(await readAgentMetadata(id)).toEqual({ agentType: 'ordered-reviewer', permissionMode: 'plan' })
  })
  for (const retain of [false, true]) test(`actual ${retain ? 'stopped' : 'evicted'} teammate resumes through SendMessage with original logical identity and disk prefix`, async () => {
    const context = makeContext(), produced = await produce(context, { retain })
    const current = definition('CURRENT_CUSTOM_INSTRUCTIONS')
    context.options.agentDefinitions = { activeAgents: [current], allAgents: [current], allowedAgentTypes: undefined }
    context.setAppState(state => ({ ...state, effortValue: 'xhigh', teamContext: { teamName: 'unrelated-team', teamFilePath: '', leadAgentId: 'ambient-lead', teammates: {} } }))
    const before = observed.length, ordinaryBefore = ordinaryCalls
    const result = await send(context, retain ? produced.name : produced.id)
    expect(result.data.success).toBe(true)
    expect(result.data.message).toContain('2 prior messages')
    const params = await finishResume(context, produced.id, before)
    expect(params.toolUseContext.getAppState().effortValue).toBe('low')
    expect(context.getAppState().effortValue).toBe('xhigh')
    expect((await readAgentMetadata(produced.id))?.effort).toBe('low')
    expect(ordinaryCalls).toBe(ordinaryBefore)
    expect(params.toolUseContext.agentId).toBe(produced.id)
    expect(params.messages.slice(0, 2).map(message => message.uuid)).toEqual(produced.transcript.messages.map(message => message.uuid))
    expect(params.messages).toHaveLength(3)
    expect(JSON.stringify(params.messages[2])).toContain('new raw prompt')
    expect(params.systemPrompt.join('\n')).toContain('CURRENT_CUSTOM_INSTRUCTIONS')
    expect(params.systemPrompt.join('\n')).not.toContain('ORIGINAL_CUSTOM_INSTRUCTIONS')
    const transcript = await getAgentTranscript(produced.id)
    expect(transcript?.messages).toHaveLength(4)
    expect(transcript?.messages.slice(0, 2)).toEqual(produced.transcript.messages)
    const rows = (await readFile(getAgentTranscriptPath(produced.id), 'utf8')).trim().split('\n').map(row => JSON.parse(row)).filter(row => row.type === 'user' || row.type === 'assistant')
    expect(rows).toHaveLength(4)
    expect(new Set(rows.map(row => row.uuid)).size).toBe(4)
    expect(rows.find(row => row.uuid === transcript!.messages[2]!.uuid)?.parentUuid).toBe(produced.transcript.messages[1]!.uuid)
    expect(rows.find(row => row.uuid === transcript!.messages[3]!.uuid)?.parentUuid).toBe(transcript!.messages[2]!.uuid)
    expect((await readAgentMetadata(produced.id))?.teamName).toBe(produced.teamName)
    expect(context.getAppState().teamContext?.teamName).toBe('unrelated-team')
    expect(context.getAppState().teamContext?.teammates[`${produced.name}@${produced.teamName}`]?.name).toBe(produced.name)
    expect((await readTeamFileAsync(produced.teamName))?.members.map(member => member.agentId)).toContain(`${produced.name}@${produced.teamName}`)
  })
  for (const corrupt of [false, true]) test(`actual transcript ${corrupt ? 'read failure' : 'absence'} keeps native cold-start semantics`, async () => {
    const context = makeContext(), produced = await produce(context)
    if (corrupt) await writeFile(getAgentTranscriptPath(produced.id), '{invalid jsonl', 'utf8')
    else await rm(getAgentTranscriptPath(produced.id))
    const before = observed.length, ordinaryBefore = ordinaryCalls
    const result = await send(context, produced.id)
    expect(result.data.success).toBe(true)
    expect(result.data.message).toContain('no prior transcript')
    const params = await finishResume(context, produced.id, before)
    expect(params.messages).toHaveLength(1)
    expect(ordinaryCalls).toBe(ordinaryBefore)
  })
  test('sender mailbox identity is retained in the resumed initial prompt', async () => {
    const context = makeContext(), produced = await produce(context), before = observed.length
    const sender = createTeammateContext({ agentId: 'sender@source-team', agentName: 'sender', teamName: 'source-team', parentSessionId: getSessionId(), planModeRequired: false, abortController: new AbortController() })
    const result = await runWithTeammateContext(sender, () => send(context, produced.name))
    expect(result.data.success).toBe(true)
    const params = await finishResume(context, produced.id, before)
    expect(JSON.stringify(params.messages.at(-1))).toContain('teammate_id=\\"sender\\"')
  })
  for (const kind of ['missing', 'wrong-case', 'allowlist', 'deny', 'untrusted', 'trusted'] as const) test(`current definition ${kind} is re-evaluated at the actual resume entrance`, async () => {
    const context = makeContext(), produced = await produce(context)
    const current = definition('CURRENT_CUSTOM_INSTRUCTIONS')
    if (kind === 'missing') context.options.agentDefinitions.activeAgents = []
    else if (kind === 'wrong-case') context.options.agentDefinitions.activeAgents = parseAgentsFromJson({ 'CUSTOM-REVIEWER': { description: 'Review', prompt: 'CURRENT_CUSTOM_INSTRUCTIONS', tools: ['*'] } })
    else if (kind === 'allowlist') context.options.agentDefinitions.allowedAgentTypes = []
    else if (kind === 'deny') context.setAppState(state => ({ ...state, toolPermissionContext: { ...state.toolPermissionContext, alwaysDenyRules: { ...state.toolPermissionContext.alwaysDenyRules, session: ['Agent(custom-reviewer)'] } } }))
    else if (kind === 'untrusted' || kind === 'trusted') {
      const origin = join(fixture, `definition-${kind}`), baseDir = join(origin, '.claude', 'agents')
      await mkdir(baseDir, { recursive: true })
      const path = join(baseDir, 'reviewer.md'); await writeFile(path, 'CURRENT_CUSTOM_INSTRUCTIONS')
      const parsed = parseAgentFromMarkdown(path, baseDir, { name: 'custom-reviewer', description: 'Review', tools: '*' }, 'CURRENT_CUSTOM_INSTRUCTIONS', 'projectSettings')
      if (!parsed) throw Error('Failed real definition parse')
      context.options.agentDefinitions.activeAgents = [parsed]
      const config = getGlobalConfig()
      saveGlobalConfig(() => ({ ...config, projects: { ...config.projects, [kind === 'trusted' ? origin : fixture]: { ...config.projects?.[origin], hasTrustDialogAccepted: true } } }))
    } else context.options.agentDefinitions.activeAgents = [current]
    const before = observed.length
    const result = await send(context, produced.name)
    expect(result.data.success).toBe(true)
    const params = await finishResume(context, produced.id, before)
    const restored = kind === 'trusted'
    expect(params.systemPrompt.join('\n').includes('CURRENT_CUSTOM_INSTRUCTIONS')).toBe(restored)
    expect(params.toolUseContext.options.tools.some(tool => tool.name === 'Bash')).toBe(restored)
    expect(params.toolUseContext.options.tools.some(tool => tool.name === 'SendMessage')).toBe(true)
    if (kind === 'missing' || kind === 'wrong-case') expect(result.data.message).not.toContain('definition was not restored')
    else if (!restored) expect(result.data.message).toContain('definition was not restored')
    saveGlobalConfig(config => ({ ...config, projects: {} }))
  })
  test('recorded bypass is not restored and recorded explicit acceptEdits stays ahead of plan-required', async () => {
    for (const bypass of [false, true]) {
      const context = makeContext(), produced = await produce(context, { planModeRequired: true })
      const metadata = (await readAgentMetadata(produced.id))!
      if (bypass) await writeAgentMetadata(produced.id, { ...metadata, permissionMode: 'bypassPermissions' })
      const before = observed.length
      const result = await send(context, produced.id)
      expect(result.data.success).toBe(true)
      const params = await finishResume(context, produced.id, before)
      expect(params.toolUseContext.getAppState().toolPermissionContext.mode).toBe(bypass ? 'plan' : 'acceptEdits')
      expect((await readAgentMetadata(produced.id))?.permissionMode).toBe(bypass ? 'plan' : 'acceptEdits')
    }
  })
  test('stale protocol/read frames drop while unread plain messages survive the actual resume path', async () => {
    const context = makeContext(), produced = await produce(context)
    const inbox = getInboxPath(produced.name, produced.teamName)
    await mkdir(join(inbox, '..'), { recursive: true })
    await writeFile(inbox, JSON.stringify([
      { from: 'old', text: 'already read', timestamp: 'old', read: true },
      { from: 'old', text: JSON.stringify({ type: 'shutdown_response' }), timestamp: 'old', read: false },
      { from: 'old', text: 'still unread', timestamp: 'old', read: false },
    ]))
    const before = observed.length
    const result = await send(context, produced.id)
    expect(result.data.success).toBe(true)
    await finishResume(context, produced.id, before)
    expect((await readMailbox(produced.name, produced.teamName)).map(message => message.text)).toEqual(['still unread'])
  })
  test('parent abort and unclaimable recorded name cannot mint a replacement task', async () => {
    for (const abort of [false, true]) {
      const context = makeContext(), produced = await produce(context)
      const reason = new Error('parent cancelled teammate resume')
      if (abort) context.abortController.abort(reason)
      else await writeAgentMetadata(produced.id, { ...(await readAgentMetadata(produced.id))!, name: 'team-lead' })
      const before = observed.length, ordinaryBefore = ordinaryCalls, idsBefore = Object.keys(context.getAppState().tasks)
      if (abort) {
        await expect(send(context, produced.id)).rejects.toBe(reason)
      } else {
        const result = await send(context, produced.id)
        expect(result.data.success).toBe(false)
        expect(result.data.message).toContain('recorded name')
      }
      expect(observed.length).toBe(before)
      expect(ordinaryCalls).toBe(ordinaryBefore)
      expect(Object.keys(context.getAppState().tasks)).toEqual(idsBefore)
    }
  })
  test('concurrent public SendMessage calls resume once and deliver the follower through the real mailbox', async () => {
    const context = makeContext(), produced = await produce(context), before = observed.length
    const gate = Promise.withResolvers<void>()
    queryGate = gate.promise
    afterReply = undefined
    try {
      const results = await Promise.all([send(context, produced.id, 'first resume prompt'), send(context, produced.id, 'follower mailbox prompt')])
      expect(results.every(result => result.data.success)).toBe(true)
      await poll(() => observed.length > before, 'single resumed query')
      expect(observed.length).toBe(before + 1)
      const tasks = Object.values(context.getAppState().tasks).filter(task => task.type === 'in_process_teammate' && task.status === 'running')
      expect(tasks).toHaveLength(1)
      expect(tasks[0]?.type === 'in_process_teammate' && tasks[0].identity.resumableAgentId).toBe(produced.id)
      expect((await readMailbox(produced.name, produced.teamName)).map(message => message.text)).toEqual(['follower mailbox prompt'])
      expect(JSON.stringify(observed.at(-1)?.messages.at(-1))).toContain('first resume prompt')
      abortReply(context)
      queryGate = undefined
      gate.resolve()
      await finishResume(context, produced.id, before)
    } finally { queryGate = undefined; gate.resolve(); abortReply(context) }
  })
  test('native team re-add refreshes only joinedAt for a previously persisted member', async () => {
    const context = makeContext(), produced = await produce(context)
    const { appendOrUpdateTeamMemberAsync } = await import('./teamHelpers.js')
    const address = `${produced.name}@${produced.teamName}`
    const member = { agentId: address, name: produced.name, color: 'green', agentType: 'persisted-original-type', joinedAt: 1, tmuxPaneId: 'old-pane', cwd: '/persisted-cwd', subscriptions: ['existing'], backendType: 'in-process' as const }
    await appendOrUpdateTeamMemberAsync(produced.teamName, member)
    const before = observed.length
    expect((await send(context, produced.id)).data.success).toBe(true)
    await finishResume(context, produced.id, before)
    const updated = (await readTeamFileAsync(produced.teamName))!.members.find(value => value.agentId === address)!
    expect(updated.joinedAt).toBeGreaterThan(1)
    expect({ ...updated, joinedAt: 1 }).toEqual(member)
  })
  test('real Worker agent.offer can withhold a definition without denying teammate resume', async () => {
    const context = makeContext(), produced = await produce(context)
    const { createModsRuntime } = await import('../../services/mods/runtime.js')
    const pluginRoot = join(fixture, 'offer-filter'); await mkdir(pluginRoot)
    const entry = join(pluginRoot, 'register.ts')
    await writeFile(entry, `export function register(on) { let input; on('agent.offer', ($, e) => { input=e; return {isOffered:false}; }); on('command.run', () => ({text:JSON.stringify(input)})); }`)
    const runtime = createModsRuntime()
    await runtime.bind({ cwd: fixture, surface: null, isInteractive: false, sessionId: 'private-resume' })
    await runtime.reconcile([{ name: 'offer-filter', storageId: 'offer-filter@test', pluginRoot, entrypoints: [entry] }])
    const snapshot = runtime.capture()
    context.modsSnapshot = snapshot
    try {
      const before = observed.length
      const result = await send(context, produced.name)
      expect(result.data.success).toBe(true)
      expect(result.data.message).toContain('definition was not restored')
      const params = await finishResume(context, produced.id, before)
      expect(params.systemPrompt.join('\n')).not.toContain('ORIGINAL_CUSTOM_INSTRUCTIONS')
      expect(params.toolUseContext.options.tools.map(tool => tool.name)).toEqual(['SendMessage'])
      expect(await snapshot.dispatch('command.run', {}, async () => ({}))).toEqual({ text: JSON.stringify({ agent: 'custom-reviewer', description: 'Review current code', source: 'flagSettings', provider: { plugin: 'flagSettings', tier: 'user' } }) })
    } finally { snapshot.release(); await runtime.dispose(); context.modsSnapshot = undefined }
  })
  test('a default general-purpose teammate keeps its full tool set after resume', async () => {
    const context = makeContext(GENERAL_PURPOSE_AGENT), produced = await produce(context)
    expect((await readAgentMetadata(produced.id))?.customAgentType).toBe('general-purpose')
    const before = observed.length
    const result = await send(context, produced.name)
    expect(result.data.success).toBe(true)
    expect(result.data.message).not.toContain('definition was not restored')
    const params = await finishResume(context, produced.id, before)
    expect(params.toolUseContext.options.tools.map(tool => tool.name)).toEqual(['SendMessage', 'Bash'])
  })
  test('real metadata description uses native Unicode/ANSI cleanup and preserves ZWJ and UTF-16 boundaries', async () => {
    for (const [description, expected] of [
      ['  a\uD800b\x1b[31m red\x1b[0m\u202E\n  c\u200c\u200d  ', 'ab red c\u200c\u200d'],
      ['x'.repeat(1023) + '😀tail', 'x'.repeat(1023) + '…'],
      ['x'.repeat(1022) + '😀tail', 'x'.repeat(1022) + '😀…'],
    ]) {
      const context = makeContext(), produced = await produce(context), metadata = (await readAgentMetadata(produced.id))!
      await writeAgentMetadata(produced.id, { ...metadata, description })
      const before = observed.length
      expect((await send(context, produced.id)).data.success).toBe(true)
      const params = await finishResume(context, produced.id, before)
      expect(JSON.stringify(params.messages.at(-1))).toContain(`summary=\\\"${expected}\\\"`)
      await poll(async () => (await readAgentMetadata(produced.id))?.description === expected, 'clean metadata')
      expect((await readAgentMetadata(produced.id))?.description).toBe(expected)
    }
  })
  test('actual persisted whitespace cleanup keeps user UUIDs separate at the resume entry', async () => {
    const context = makeContext()
    replyText = '   '
    let produced: Awaited<ReturnType<typeof produce>>
    try { produced = await produce(context) } finally { replyText = 'real runner reply' }
    const before = observed.length
    expect((await send(context, produced.id)).data.success).toBe(true)
    const params = await finishResume(context, produced.id, before)
    expect(params.messages.map(message => message.type)).toEqual(['user', 'user'])
    expect(params.messages[0]?.uuid).toBe(produced.transcript.messages[0]?.uuid)
    expect(params.messages[1]?.uuid).not.toBe(params.messages[0]?.uuid)
    const transcript = await getAgentTranscript(produced.id)
    expect(transcript?.messages).toHaveLength(3)
    expect(transcript?.messages[0]?.uuid).toBe(params.messages[0]?.uuid)
    expect(transcript?.messages[1]?.uuid).toBe(params.messages[1]?.uuid)
  })
  test('cleanup fixture after actual transport assertions', async () => {
    for (const context of contexts) for (const task of Object.values(context.getAppState().tasks)) if (task.type === 'in_process_teammate') { task.abortController?.abort(); task.unregisterCleanup?.() }
    await flushSessionStorage()
    switchSession(previousSession, previousProject ?? undefined)
    saveGlobalConfig(config => ({ ...config, projects: {} }))
    resetGitFileWatcher()
    await rm(fixture, { recursive: true, force: true })
    console.log('teammate resume production complete')
  })
}
