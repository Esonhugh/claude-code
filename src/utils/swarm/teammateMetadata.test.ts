import { expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AttachmentMessage } from '../../types/message.js'
import type { QueryParams } from '../../query.js'
import type { ToolUseContext } from '../../Tool.js'

const childEnv = 'CLAUDE_CODE_TEAMMATE_METADATA_TEST_CHILD'
if (process.env[childEnv] !== '1') {
  test('teammate metadata production passes in an isolated process', async () => {
    const child = Bun.spawn([process.execPath, 'test', '--timeout', '30000', import.meta.path], {
      cwd: import.meta.dir, env: { ...process.env, [childEnv]: '1' }, stdout: 'pipe', stderr: 'pipe', timeout: 60000,
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw Error(`Isolated metadata suite failed (${code})\n${stdout}\n${stderr}`)
    expect(`${stdout}\n${stderr}`).toContain('teammate metadata production complete')
    expect(code).toBe(0)
  }, 65000)
} else {
  await isolatedTests()
}

async function isolatedTests() {
  let queryDone: (() => void) | undefined
  const observed: QueryParams[] = []
  mock.module('../../query.js', () => ({
    async *query(params: QueryParams) {
      observed.push(params)
      yield createAssistantMessage({ content: 'persisted reply' })
      queryDone?.()
      return { reason: 'completed' }
    },
  }))
  const promptsModule = await import('../../constants/prompts.js')
  mock.module('../../constants/prompts.js', () => ({ ...promptsModule, getSystemPrompt: async () => asSystemPrompt(['deterministic core']) }))
  const { asSystemPrompt } = await import('../systemPromptType.js')
  const { createUserMessage, createAssistantMessage } = await import('../messages.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createFileStateCacheWithSizeLimit } = await import('../fileStateCache.js')
  const { switchSession, getSessionId, getSessionProjectDir } = await import('../../bootstrap/state.js')
  const { asSessionId, asAgentId } = await import('../../types/ids.js')
  const { spawnInProcessTeammate } = await import('./spawnInProcess.js')
  const { runInProcessTeammate } = await import('./inProcessRunner.js')
  const { runAgent } = await import('../../tools/AgentTool/runAgent.js')
  const { GENERAL_PURPOSE_AGENT } = await import('../../tools/AgentTool/built-in/generalPurposeAgent.js')
  const { readAgentMetadata, getAgentTranscript, getAgentTranscriptPath, flushSessionStorage, recordSidechainTranscript } = await import('../sessionStorage.js')
  const { createAgentId } = await import('../uuid.js')
  const { resetGitFileWatcher } = await import('../git/gitFilesystem.js')
  const previousSession = getSessionId(), previousProject = getSessionProjectDir()
  const fixture = await mkdtemp(join(tmpdir(), 'teammate-metadata-'))
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  switchSession(asSessionId(crypto.randomUUID()), join(fixture, 'project'))
  function makeContext() {
    let state = getDefaultAppState()
    const context: ToolUseContext = {
      options: {
        commands: [], debug: false, mainLoopModel: 'claude-sonnet-4-6', tools: [], verbose: false,
        thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: false,
        agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined },
      },
      abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
      getAppState: () => state, setAppState: updater => { state = updater(state) }, setInProgressToolUseIDs: () => {},
      setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {}, messages: [],
    } as ToolUseContext
    return context
  }
  async function waitMetadata(id: ReturnType<typeof asAgentId>) {
    for (let i = 0; i < 100; i++) {
      const result = await readAgentMetadata(id)
      if (result) return result
      await Bun.sleep(10)
    }
    throw Error('Metadata write did not settle')
  }
  for (const planModeRequired of [false, true]) {
    test(`actual mint → teammate runner → runAgent → disk preserves resume metadata (plan=${planModeRequired})`, async () => {
      const context = makeContext()
      context.agentId = createAgentId('parent')
      const name = planModeRequired ? 'planned-reviewer' : 'reviewer'
      const spawned = await spawnInProcessTeammate({ name, teamName: 'metadata-team', prompt: 'original raw prompt', description: 'Review original task', color: 'blue', planModeRequired, permissionMode: 'acceptEdits', model: 'claude-sonnet-4-6' }, context)
      if (!spawned.identity || !spawned.taskId || !spawned.abortController || !spawned.teammateContext) throw Error('No produced teammate')
      expect(spawned.identity.resumableAgentId).toMatch(/^a[\w-]+-[0-9a-f]{16}$/)
      queryDone = () => spawned.abortController!.abort()
      const definition = { agentType: 'custom-reviewer', whenToUse: 'Review', getSystemPrompt: () => 'custom instruction', tools: [], source: 'projectSettings' as const }
      await runInProcessTeammate({ identity: spawned.identity, taskId: spawned.taskId, prompt: 'original raw prompt', description: 'Review original task', model: 'claude-sonnet-4-6', effort: 'low', agentDefinition: definition, teammateContext: spawned.teammateContext, toolUseContext: context, abortController: spawned.abortController })
      const id = asAgentId(spawned.identity.resumableAgentId!)
      expect(await waitMetadata(id)).toEqual({ agentType: name, name, description: 'Review original task', parentAgentId: context.agentId, taskKind: 'in_process_teammate', teamName: 'metadata-team', color: 'blue', planModeRequired, customAgentType: 'custom-reviewer', model: 'claude-sonnet-4-6', effort: 'low', permissionMode: 'acceptEdits' })
      expect(observed.at(-1)?.toolUseContext.getAppState().effortValue).toBe('low')
      expect(context.getAppState().effortValue).toBeUndefined()
      expect(observed.at(-1)?.toolUseContext.agentId).toBe(id)
      await flushSessionStorage()
      const transcript = await getAgentTranscript(id)
      expect(transcript?.messages.map(message => message.type)).toEqual(['user', 'assistant'])
      const metadataFile = getAgentTranscriptPath(id).replace(/\.jsonl$/, '.meta.json')
      expect(JSON.parse(await readFile(metadataFile, 'utf8'))).toEqual(await readAgentMetadata(id))
    })
  }
  test('spawn permission mode honors explicit selection before plan requirement and inherits the parent only when omitted', async () => {
    for (const [parent, planModeRequired, explicit, expected] of [
      ['default', true, 'acceptEdits', 'acceptEdits'],
      ['bypassPermissions', true, 'default', 'default'],
      ['default', true, 'bypassPermissions', 'bypassPermissions'],
      ['acceptEdits', true, undefined, 'plan'],
      ['plan', false, undefined, 'default'],
      ['dontAsk', false, undefined, 'default'],
      ['acceptEdits', false, undefined, 'acceptEdits'],
      ['bypassPermissions', false, undefined, 'bypassPermissions'],
    ] as const) {
      const context = makeContext()
      context.setAppState(state => ({ ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: parent } }))
      const getState = context.getAppState
      let reads = 0
      context.getAppState = () => { reads++; return getState() }
      const spawned = await spawnInProcessTeammate({ name: 'permission-reviewer', teamName: 'permission-team', prompt: 'check mode', planModeRequired, ...(explicit === undefined ? {} : { permissionMode: explicit }) }, context)
      expect(reads).toBe(explicit === undefined ? 1 : 0)
      if (!spawned.taskId || !spawned.abortController) throw Error('No produced teammate')
      const task = context.getAppState().tasks[spawned.taskId]
      expect(task?.type).toBe('in_process_teammate')
      if (task?.type !== 'in_process_teammate') throw Error('Wrong task type')
      expect(task.permissionMode).toBe(expected)
      spawned.abortController.abort()
      task.unregisterCleanup?.()
    }
  })
  test('actual minted teammate runs two turns without duplicate disk rows and omits absent launch fields', async () => {
    const context = makeContext()
    const spawned = await spawnInProcessTeammate({ name: 'plain-reviewer', teamName: 'metadata-team', prompt: 'first prompt', planModeRequired: false, permissionMode: 'default' }, context)
    if (!spawned.identity || !spawned.taskId || !spawned.abortController || !spawned.teammateContext) throw Error('No produced teammate')
    let turn = 0
    queryDone = () => {
      turn++
      if (turn === 1) context.setAppState(prev => {
        const task = prev.tasks[spawned.taskId!]
        if (task.type !== 'in_process_teammate') throw Error('No active teammate')
        return { ...prev, tasks: { ...prev.tasks, [task.id]: { ...task, pendingUserMessages: ['next real turn'] } } }
      })
      else spawned.abortController!.abort()
    }
    await runInProcessTeammate({ identity: spawned.identity, taskId: spawned.taskId, prompt: 'first prompt', teammateContext: spawned.teammateContext, toolUseContext: context, abortController: spawned.abortController })
    expect(turn).toBe(2)
    const id = asAgentId(spawned.identity.resumableAgentId!)
    expect(await waitMetadata(id)).toEqual({ agentType: 'plain-reviewer', name: 'plain-reviewer', permissionMode: 'default', taskKind: 'in_process_teammate', teamName: 'metadata-team', planModeRequired: false, model: 'claude-sonnet-4-6' })
    await flushSessionStorage()
    const transcript = await getAgentTranscript(id)
    expect(transcript?.messages.map(message => message.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const rows = (await readFile(getAgentTranscriptPath(id), 'utf8')).trim().split('\n').map(row => JSON.parse(row)).filter(row => row.type === 'user' || row.type === 'assistant')
    expect(rows).toHaveLength(4)
    expect(rows[2].parentUuid).toBe(rows[1].uuid)
    expect(new Set(rows.map(row => row.uuid)).size).toBe(4)
  })
  test('ordinary runAgent remains ordinary and never writes teammate fields', async () => {
    queryDone = undefined
    const id = createAgentId('ordinary')
    const context = makeContext()
    for await (const _ of runAgent({ agentDefinition: GENERAL_PURPOSE_AGENT, promptMessages: [createUserMessage({ content: 'ordinary task' })], toolUseContext: context, canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }), isAsync: false, querySource: 'agent:test', availableTools: [], override: { agentId: id, userContext: {}, systemContext: {}, systemPrompt: asSystemPrompt([]) } })) { /* drain */ }
    // No mode was asked for, so none is recorded and a resume keeps following the parent.
    expect(await waitMetadata(id)).toEqual({ agentType: 'general-purpose', model: 'claude-sonnet-4-6' })
  })
  test('recordedUuids stitches only new messages to the existing disk chain and carries the ledger into the next turn', async () => {
    queryDone = undefined
    const id = createAgentId('continuity'), context = makeContext()
    const previous = createUserMessage({ content: 'already on disk' })
    await recordSidechainTranscript([previous], id)
    await flushSessionStorage()
    const recordedUuids = new Set([previous.uuid])
    const nextPrompt = createUserMessage({ content: 'next turn' })
    const params: Parameters<typeof runAgent>[0] & { recordedUuids: typeof recordedUuids } = { agentDefinition: GENERAL_PURPOSE_AGENT, forkContextMessages: [previous], promptMessages: [nextPrompt], toolUseContext: context, canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }), isAsync: false, querySource: 'agent:test', availableTools: [], override: { agentId: id, userContext: {}, systemContext: {}, systemPrompt: asSystemPrompt([]) }, recordedUuids }
    for await (const _ of runAgent(params)) { /* drain */ }
    await flushSessionStorage()
    const transcript = await getAgentTranscript(id)
    expect(transcript?.messages.map(message => message.uuid).slice(0, 2)).toEqual([previous.uuid, nextPrompt.uuid])
    expect(transcript?.messages).toHaveLength(3)
    expect(recordedUuids.has(nextPrompt.uuid)).toBe(true)
    expect(recordedUuids.has(transcript!.messages[2]!.uuid)).toBe(true)
    const rows = (await readFile(getAgentTranscriptPath(id), 'utf8')).trim().split('\n').map(row => JSON.parse(row)).filter(row => row.type === 'user' || row.type === 'assistant')
    expect(rows.map(row => row.uuid)).toEqual(transcript!.messages.map(message => message.uuid))
    expect(rows[1].parentUuid).toBe(previous.uuid)
    const followUp = createUserMessage({ content: 'third turn' })
    for await (const _ of runAgent({ ...params, forkContextMessages: transcript!.messages, promptMessages: [followUp] })) { /* drain */ }
    await flushSessionStorage()
    const continued = await getAgentTranscript(id)
    expect(continued?.messages).toHaveLength(5)
    expect(continued?.messages.slice(0, 3)).toEqual(transcript!.messages)
    expect(recordedUuids.size).toBe(5)
    const continuedRows = (await readFile(getAgentTranscriptPath(id), 'utf8')).trim().split('\n').map(row => JSON.parse(row)).filter(row => row.type === 'user' || row.type === 'assistant')
    expect(continuedRows).toHaveLength(5)
    expect(continuedRows[3].parentUuid).toBe(transcript!.messages[2]!.uuid)
  })
  test('the ledger and parent chain skip messages rejected by the transcript writer', async () => {
    queryDone = undefined
    const id = createAgentId('filtered'), context = makeContext()
    const user = createUserMessage({ content: 'record me' })
    const ignored: AttachmentMessage = { type: 'attachment', uuid: randomUUID(), timestamp: new Date().toISOString(), attachment: { type: 'hook_success', content: '', hookName: 'fixture hook', toolUseID: 'fixture', hookEvent: 'SubagentStart' } }
    const recordedUuids = new Set<typeof user.uuid>()
    for await (const _ of runAgent({ agentDefinition: GENERAL_PURPOSE_AGENT, promptMessages: [user, ignored], toolUseContext: context, canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }), isAsync: false, querySource: 'agent:test', availableTools: [], override: { agentId: id, userContext: {}, systemContext: {}, systemPrompt: asSystemPrompt([]) }, recordedUuids })) { /* drain */ }
    await flushSessionStorage()
    expect(recordedUuids.has(user.uuid)).toBe(true)
    expect(recordedUuids.has(ignored.uuid)).toBe(false)
    const transcript = await getAgentTranscript(id)
    expect(transcript?.messages.map(message => message.type)).toEqual(['user', 'assistant'])
    const rows = (await readFile(getAgentTranscriptPath(id), 'utf8')).trim().split('\n').map(row => JSON.parse(row)).filter(row => row.type === 'user' || row.type === 'assistant')
    expect(rows[1].parentUuid).toBe(user.uuid)
  })
  test('cleanup fixture after production assertions', async () => {
    await flushSessionStorage()
    switchSession(previousSession, previousProject ?? undefined)
    resetGitFileWatcher()
    await rm(fixture, { recursive: true, force: true })
    console.log('teammate metadata production complete')
  })
}
