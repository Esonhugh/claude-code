import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childSource = `
  import assert from 'node:assert/strict'
  import { spyOn } from 'bun:test'
  const state = await import(${JSON.stringify(new URL('../../bootstrap/state.ts', import.meta.url).href)})
  const { enableConfigs } = await import(${JSON.stringify(new URL('../../utils/config.ts', import.meta.url).href)})
  state.setOriginalCwd(process.cwd())
  enableConfigs()
  const { getDefaultAppState } = await import(${JSON.stringify(new URL('../../state/AppStateStore.ts', import.meta.url).href)})
  const { AgentTool } = await import(${JSON.stringify(new URL('../../tools/AgentTool/AgentTool.tsx', import.meta.url).href)})
  const { GENERAL_PURPOSE_AGENT } = await import(${JSON.stringify(new URL('../../tools/AgentTool/built-in/generalPurposeAgent.ts', import.meta.url).href)})
  const { registerAsyncAgent, enqueueAgentNotification } = await import(${JSON.stringify(new URL('../../tasks/LocalAgentTask/LocalAgentTask.tsx', import.meta.url).href)})
  const { getCommandQueue, resetCommandQueue } = await import(${JSON.stringify(new URL('../../utils/messageQueueManager.ts', import.meta.url).href)})
  const { createModToolHost } = await import(${JSON.stringify(new URL('./toolHost.ts', import.meta.url).href)})
  const scenario = JSON.parse(process.env.MODS_SPAWN_NOTICE_CASE)
  let root = getDefaultAppState()
  let view = getDefaultAppState()
  let viewWrites = 0
  const writeRoot = updater => { root = updater(root) }
  const writeView = updater => { viewWrites++; view = updater(view) }
  const taskId = scenario.rootWriter ? 'distinct-task-id' : 'owned-agent'
  const context = {
    options: { tools: [], mcpClients: [], isNonInteractiveSession: true },
    abortController: new AbortController(), messages: [],
    getAppState: () => scenario.rootWriter ? view : root,
    setAppState: scenario.rootWriter ? writeView : writeRoot,
    ...(scenario.rootWriter ? { setAppStateForTasks: writeRoot } : {}),
  }
  const settled = Promise.withResolvers()
  // Substitute only the launch boundary; registration, root store and queue
  // below are production modules. Real Agent execution is covered by tmux.
  const call = spyOn(AgentTool, 'call').mockImplementation(async (input, child) => {
    assert.equal(input.run_in_background, true)
    assert.equal(child.modSpawnedBy, 'author')
    if (scenario.kind === 'local_agent') {
      registerAsyncAgent({ agentId: 'owned-agent', description: 'owned', prompt: 'owned',
        selectedAgent: GENERAL_PURPOSE_AGENT, setAppState: writeRoot, spawnDepth: 1 })
      writeRoot(prev => {
        const tasks = { ...prev.tasks }
        const task = { ...tasks['owned-agent'], id: taskId, notified: scenario.alreadyNotified === true }
        delete tasks['owned-agent']
        tasks[taskId] = task
        return { ...prev, tasks }
      })
    } else if (scenario.kind !== 'missing') {
      writeRoot(prev => ({ ...prev, tasks: { ...prev.tasks,
        [taskId]: { id: taskId, agentId: 'owned-agent', type: scenario.kind, status: 'running', notified: false } } }))
    }
    child.modAgentStarted({ model: 'test-model', agentId: 'owned-agent' })
    await settled.promise
    return { data: {} }
  })
  try {
    const host = createModToolHost(context, async () => { throw new Error('launch fixture cannot prompt') })
    assert.deepEqual(await host.spawn({ prompt: 'owned' }, { hasHooks: () => false },
      new AbortController().signal, 'author'), { model: 'test-model', agentId: 'owned-agent' })
    assert.equal(viewWrites, 0)
    if (scenario.kind === 'local_agent') {
      assert.equal(root.tasks[taskId].status, 'running')
      assert.equal(root.tasks[taskId].notified, true)
      writeRoot(prev => ({ ...prev, tasks: { ...prev.tasks,
        [taskId]: { ...prev.tasks[taskId], status: scenario.status } } }))
      enqueueAgentNotification({ taskId, description: 'owned', status: scenario.status,
        setAppState: writeRoot, finalMessage: 'owned result', error: 'owned error' })
      assert.equal(getCommandQueue().length, 0)
    } else if (scenario.kind !== 'missing') {
      assert.equal(root.tasks[taskId].notified, false)
    }
    registerAsyncAgent({ agentId: 'ordinary-agent', description: 'ordinary', prompt: 'ordinary',
      selectedAgent: GENERAL_PURPOSE_AGENT, setAppState: writeRoot, spawnDepth: 1 })
    const notice = { taskId: 'ordinary-agent', description: 'ordinary', status: scenario.status,
      setAppState: writeRoot, finalMessage: 'ordinary result', error: 'ordinary error',
      usage: { totalTokens: 5, toolUses: 1, durationMs: 9 } }
    enqueueAgentNotification(notice)
    const queue = getCommandQueue()
    assert.equal(queue.length, 1)
    assert.equal(queue[0].mode, 'task-notification')
    assert.ok(queue[0].value.includes('<task-id>ordinary-agent</task-id>'))
    assert.ok(queue[0].value.includes('<status>' + scenario.status + '</status>'))
    assert.ok(queue[0].value.includes('<total_tokens>5</total_tokens>'))
    enqueueAgentNotification(notice)
    assert.equal(getCommandQueue().length, 1)
    assert.equal(root.tasks['ordinary-agent'].notified, true)
  } finally {
    settled.resolve()
    call.mockRestore()
    resetCommandQueue()
  }
`

const cases = [
  ...(['completed', 'failed', 'killed'] as const).flatMap(status => [false, true].map(rootWriter => ({
    label: `${status}, root task writer=${rootWriter}`, kind: 'local_agent', status, rootWriter,
  }))),
  { label: 'already claimed', kind: 'local_agent', status: 'completed', alreadyNotified: true },
  { label: 'teammate', kind: 'in_process_teammate', status: 'completed' },
  { label: 'remote task', kind: 'remote_agent', status: 'completed' },
  { label: 'missing task', kind: 'missing', status: 'completed' },
]

for (const scenario of cases) {
  test(`author spawn completion ownership: ${scenario.label}`, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'mods-spawn-notice-')))
    try {
      const child = Bun.spawn([process.execPath, '--eval', childSource], {
        cwd: directory,
        env: {
          PATH: process.env.PATH, HOME: directory, TMPDIR: directory, NODE_ENV: 'production',
          CLAUDE_CONFIG_DIR: join(directory, 'config'), ANTHROPIC_API_KEY: 'mods-spawn-notice-unused-key',
          MODS_SPAWN_NOTICE_CASE: JSON.stringify(scenario),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      expect(code).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
