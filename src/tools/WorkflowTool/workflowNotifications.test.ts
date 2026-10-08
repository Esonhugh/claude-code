import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setIsInteractive } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  killWorkflowTask, pauseWorkflowTask, type LocalWorkflowTaskState,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { drainSdkEvents } from '../../utils/sdkEventQueue.js'
import { runWorkflowPlan } from './runWorkflow.js'
import { loadWorkflowRunSession } from './workflowRunSessions.js'
import { runWorkflowScript } from './workflowScriptRuntime.js'
import type { WorkflowDryRunPlan } from './workflowSpec.js'

const roots: string[] = []
afterEach(async () => {
  dequeueAllMatching(command => command.mode === 'task-notification')
  drainSdkEvents()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

for (const entry of ['plan', 'script'] as const) {
  for (const status of ['completed', 'failed', 'killed', 'paused'] as const) {
    test(`${entry} ${status} publishes only terminal notifications with measured usage`, async () => {
      setIsInteractive(false)
      drainSdkEvents()
      dequeueAllMatching(command => command.mode === 'task-notification')
      const cwd = await mkdtemp(join(tmpdir(), 'workflow-notification-'))
      roots.push(cwd)
      let state = { tasks: {}, toolPermissionContext: { mode: 'default' } } as unknown as AppState
      const setAppState = (update: (state: AppState) => AppState) => { state = update(state) }
      const task = () => Object.values(state.tasks).find(
        (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
      )!
      let calls = 0
      const agentTool = {
        name: 'Agent',
        async call(
          _input: unknown, _context: ToolUseContext, _allow: unknown, _message: unknown,
          onProgress?: (event: unknown) => void,
        ) {
          calls++
          onProgress?.({ data: { type: 'agent_progress', message: {
            type: 'assistant', uuid: '00000000-0000-4000-8000-000000000001',
            timestamp: '2026-10-04T00:00:00.000Z', message: {
              id: 'msg_notification_usage', role: 'assistant', model: 'claude-test',
              content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'fixture' } }],
              stop_reason: 'tool_use', stop_sequence: null,
              usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: null, cache_creation_input_tokens: null },
            },
          } } })
          if (status === 'killed') killWorkflowTask(task().id, setAppState)
          if (status === 'paused') pauseWorkflowTask(task().id, setAppState)
          if (status !== 'completed') throw new Error('terminal <failure>')
          return { data: { status: 'completed', content: [{ type: 'text', text: 'result <ok>' }], totalDurationMs: 1 } }
        },
      }
      const context = {
        getAppState: () => state, setAppState, getCwd: () => cwd,
        options: { tools: [agentTool], mainLoopModel: 'claude-sonnet-4-6', workflowRunInForeground: true },
        abortController: new AbortController(), toolUseId: 'toolu_terminal',
      } as unknown as ToolUseContext
      const script = 'export const meta = { name: "notification", description: "Description <safe>", phases: [{title: "root", detail: "One worker"}] }; phase("root"); return await agent("Reply once");'
      const plan: WorkflowDryRunPlan = {
        name: 'notification', description: 'Description <safe>',
        defaults: { maxConcurrency: 1, maxAgents: 1, maxRetries: 0, fanout: 1, concurrency: 1, review: 'none', permissionMode: 'bypassPermissions', execution: 'agent' },
        phases: [{ id: 'root', description: 'Root', prompt: 'Reply once', dependsOn: [], fanout: 1, concurrency: 1, review: 'none', permissionMode: 'bypassPermissions' }],
        totalAgents: 1, runScriptSnapshot: script,
      }
      const workflowRunId = `wf_notification_${entry}_${status}`
      const input = { plan, context, workflowRunId, canUseTool: async () => ({ behavior: 'allow' as const }), assistantMessage: { message: { id: 'msg_parent' } } as never }
      const run = () => entry === 'plan' ? runWorkflowPlan(input) : runWorkflowScript({ ...input, script, scriptPath: join(cwd, 'notification.js') })
      await run()
      const finished = task()
      const session = await loadWorkflowRunSession({ cwd, workflowRunId })
      expect(finished.status, finished.error).toBe(status === 'paused' ? 'pending' : status)
      expect(session?.status).toBe(status)
      expect(finished.tokenCount).toBe(110)
      expect(finished.toolUseCount).toBe(1)
      const notifications = dequeueAllMatching(command => command.mode === 'task-notification')
      const sdk = drainSdkEvents().filter(event => event.subtype === 'task_notification')
      if (status === 'paused') {
        expect(notifications).toEqual([])
        expect(sdk).toEqual([])
        expect(finished.notified).toBe(false)
        return
      }
      expect(notifications).toHaveLength(1)
      const text = String(notifications[0]!.value)
      expect(text).toContain(`<task-id>${finished.id}</task-id>`)
      expect(text).toContain(`<status>${status}</status>`)
      expect(text).toContain('<tool-use-id>toolu_terminal</tool-use-id>')
      expect(text).toContain('Description &lt;safe&gt;')
      expect(text).toContain('<total_tokens>110</total_tokens><tool_uses>1</tool_uses>')
      expect(text).toMatch(/<duration_ms>\d+<\/duration_ms>/)
      expect(finished.notified).toBe(true)
      expect(sdk).toHaveLength(1)
      expect(sdk[0]).toMatchObject({ task_id: finished.id, status: status === 'killed' ? 'stopped' : status, usage: { total_tokens: 110, tool_uses: 1 } })
      if (status === 'completed') expect(text).toContain('result &lt;ok&gt;')
      if (status === 'failed') expect(text).toContain('terminal &lt;failure&gt;')
      expect(await readFile(finished.outputFile, 'utf8')).not.toBe('')
      await run()
      expect(calls).toBe(1)
      expect(dequeueAllMatching(command => command.mode === 'task-notification')).toEqual([])
      expect(drainSdkEvents()).toEqual([])
    })
  }
}
