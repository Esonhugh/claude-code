import { afterAll, expect, test } from 'bun:test'
import React from 'react'
import { rm } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'

process.env.CLAUDE_CODE_ENABLE_TASKS = '1'
process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1'
process.env.CLAUDE_CODE_TASK_LIST_ID = `spinner-idle-${process.pid}-${Date.now()}`

const { render } = await import('../ink.js')
const { AppStateProvider } = await import('../state/AppState.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createTask, getTasksDir } = await import('../utils/tasks.js')
const { SpinnerWithVerb } = await import('./Spinner.js')

const taskListId = process.env.CLAUDE_CODE_TASK_LIST_ID
await createTask(taskListId, { subject: 'write intro', description: '', status: 'pending', blocks: [], blockedBy: [] })
afterAll(async () => {
  delete process.env.CLAUDE_CODE_TASK_LIST_ID
  await rm(getTasksDir(taskListId), { recursive: true, force: true })
})

const teammate = {
  id: 't1',
  type: 'in_process_teammate',
  status: 'running',
  isIdle: true,
  startTime: Date.now(),
  identity: { agentId: 'writer@docs', agentName: 'writer', teamName: 'docs', color: 'blue', planModeRequired: false, parentSessionId: 's' },
  progress: { tokenCount: 0, toolUseCount: 0 },
  messages: [],
}

test('idle leader with running teammates still shows the ctrl+t task list', async () => {
  const stdout = Object.assign(new PassThrough(), { columns: 110, rows: 40, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const ref = <T,>(current: T) => ({ current })
  const instance = await render(
    <AppStateProvider initialState={{ ...getDefaultAppState(), expandedView: 'tasks', tasks: { t1: teammate } } as never}>
      <SpinnerWithVerb
        mode="responding"
        loadingStartTimeRef={ref(Date.now())}
        totalPausedMsRef={ref(0)}
        pauseStartTimeRef={ref(null)}
        responseLengthRef={ref(0)}
        verbose={false}
        leaderIsIdle
      />
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    await new Promise(resolve => setTimeout(resolve, 200))
    const text = stripAnsi(output)
    expect(text).toContain('Idle')
    expect(text).toContain('write intro')
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})
