import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = mkdtempSync(join(tmpdir(), 'idle-shutdown-'))
process.env.CLAUDE_CONFIG_DIR = configDir
afterAll(() => rmSync(configDir, { recursive: true, force: true }))

let prompts: string[] = []
let lifecycle: AbortController | undefined

const realPrompts = await import('../../constants/prompts.js')
mock.module('../../constants/prompts.js', () => ({
  ...realPrompts,
  getSystemPrompt: async () => ['CORE_IDENTITY'],
}))
const realRunAgent = await import('../../tools/AgentTool/runAgent.js')
mock.module('../../tools/AgentTool/runAgent.js', () => ({
  ...realRunAgent,
  async *runAgent(params: { promptMessages: Array<{ message: { content: unknown } }> }) {
    prompts.push(JSON.stringify(params.promptMessages.at(-1)?.message.content))
    yield {
      type: 'assistant',
      uuid: crypto.randomUUID(),
      message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
    }
    // The model was asked about the shutdown: end the test instead of answering.
    if (prompts.length === 2) lifecycle?.abort()
  },
}))

const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { getEmptyToolPermissionContext } = await import('../../Tool.js')
const { createTask } = await import('../tasks.js')
const { createShutdownRequestMessage, readMailbox, writeToMailbox } = await import('../teammateMailbox.js')
const { spawnInProcessTeammate } = await import('./spawnInProcess.js')
const { runInProcessTeammate } = await import('./inProcessRunner.js')

async function runTeammate(teamName: string, before?: () => Promise<void>) {
  prompts = []
  let state = { ...getDefaultAppState(), toolPermissionContext: getEmptyToolPermissionContext(), tasks: {} }
  const setState = (updater: (prev: typeof state) => typeof state) => { state = updater(state) }
  const spawned = await spawnInProcessTeammate(
    { name: 'dates', teamName, prompt: 'fix dates.py', planModeRequired: false, permissionMode: 'default' },
    { setAppState: setState as never },
  )
  if (!spawned.taskId || !spawned.abortController || !spawned.teammateContext) throw Error('spawn failed')
  lifecycle = spawned.abortController
  await before?.()
  await writeToMailbox('dates', {
    from: 'team-lead',
    text: JSON.stringify(createShutdownRequestMessage({ requestId: 'shutdown-1@dates', from: 'team-lead', reason: 'all done' })),
    timestamp: new Date().toISOString(),
  }, teamName)
  await runInProcessTeammate({
    identity: { agentId: `dates@${teamName}`, agentName: 'dates', teamName, color: 'blue', planModeRequired: false, parentSessionId: 'session' },
    taskId: spawned.taskId,
    prompt: 'fix dates.py',
    teammateContext: spawned.teammateContext,
    toolUseContext: {
      options: { tools: [], mainLoopModel: 'claude-sonnet-4-6', mcpClients: [] },
      abortController: new AbortController(),
      readFileState: {},
      getAppState: () => state,
      setAppState: setState,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => 0,
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
    } as never,
    abortController: spawned.abortController,
  })
  const approvals = (await readMailbox('team-lead', teamName)).filter(m => m.text.includes('"shutdown_approved"'))
  return { approvals }
}

test('an idle teammate with nothing left to do approves shutdown without a model round', async () => {
  const { approvals } = await runTeammate('idle-team')
  expect(prompts).toHaveLength(1)
  expect(approvals).toHaveLength(1)
  expect(JSON.parse(approvals[0]!.text)).toMatchObject({ type: 'shutdown_approved', requestId: 'shutdown-1@dates', from: 'dates', backendType: 'in-process' })
  expect(lifecycle?.signal.aborted).toBe(true)
})

test('a teammate that still owns an unfinished task decides on shutdown itself', async () => {
  const { approvals } = await runTeammate('busy-team', async () => {
    await createTask('busy-team', { subject: 'fix dates.py', description: 'fix it', status: 'in_progress', owner: 'dates', blocks: [], blockedBy: [] })
  })
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('shutdown_request')
  expect(approvals).toHaveLength(0)
})

test('a teammate with another unread message decides on shutdown itself', async () => {
  const { approvals } = await runTeammate('unread-team', async () => {
    await writeToMailbox('dates', { from: 'money', text: 'can you also check money.py?', timestamp: new Date().toISOString() }, 'unread-team')
  })
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('shutdown_request')
  expect(approvals).toHaveLength(0)
})
