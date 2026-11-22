import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

import type { ToolUseContext } from '../../Tool.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { Message } from '../../types/message.js'
import type { AgentId } from '../../types/ids.js'

const configDir = mkdtempSync(join(tmpdir(), 'tasks-dialog-rows-'))
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.ANTHROPIC_API_KEY = 'test-key'
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = { VERSION: '0.0.0-test' }

const { render } = await import('../../ink.js')
const { AppStateProvider, getDefaultAppState, useAppState } = await import('../../state/AppState.js')
const { KeybindingSetup } = await import('../../keybindings/KeybindingProviderSetup.js')
const { BackgroundTasksDialog } = await import('./BackgroundTasksDialog.js')
const { addSessionCronTask, getSessionCronTasks, removeSessionCronTasks } = await import('../../bootstrap/state.js')
const { getAgentTranscriptPath } = await import('../../utils/sessionStorage.js')
const { persistForkedSkillScope } = await import('../../utils/forkedSkillScope.js')

class TestStdout extends Writable {
  columns = 120
  rows = 40
  isTTY = false
  output = ''
  _write(chunk: string | Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.output += chunk.toString()
    callback()
  }
}

class TestStdin extends Readable {
  isTTY = true
  isRaw = false
  _read() {}
  setRawMode(value: boolean) {
    this.isRaw = value
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}

const doneAgent: LocalAgentTaskState = {
  id: 'done-agent',
  type: 'local_agent',
  status: 'completed',
  description: 'alpha worker',
  startTime: 1,
  outputFile: '',
  outputOffset: 0,
  notified: true,
  agentId: 'done-agent',
  prompt: 'say hi',
  agentType: 'general-purpose',
  spawnDepth: 0,
  retrieved: false,
  lastReportedToolCount: 0,
  lastReportedTokenCount: 0,
  isBackgrounded: true,
  pendingMessages: [],
  retain: false,
  diskLoaded: false,
}

let state: AppState
let unmount: (() => void) | undefined

async function open(initial: Partial<AppState>) {
  const out = new TestStdout()
  const stdin = new TestStdin()
  const done: string[] = []
  const appended: Message[] = []
  state = { ...getDefaultAppState(), ...initial }
  function Harness() {
    state = useAppState(s => s)
    return (
      <BackgroundTasksDialog
        onDone={result => done.push(String(result))}
        toolUseContext={{
          setMessages: (update: (prev: Message[]) => Message[]) => {
            appended.push(...update([]))
          },
        } as unknown as ToolUseContext}
      />
    )
  }
  const instance = await render(
    <AppStateProvider initialState={state}>
      <KeybindingSetup>
        <Harness />
      </KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: out as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  unmount = () => {
    instance.unmount()
    instance.cleanup()
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 120))
  await settle()
  return {
    done,
    appended,
    async press(key: string) {
      out.output = ''
      stdin.push(key)
      await settle()
    },
    /** What the last key press drew. */
    screen: () => stripAnsi(out.output),
  }
}

beforeEach(() => {
  removeSessionCronTasks(getSessionCronTasks().map(task => task.id))
})

afterEach(() => {
  unmount?.()
  unmount = undefined
  rmSync(join(configDir, 'projects'), { recursive: true, force: true })
})

test('Enter on a completed agent reopens it, like 2.1.329', async () => {
  const dialog = await open({ tasks: { 'done-agent': doneAgent } })
  await dialog.press('\r')
  expect(state.viewingAgentTaskId).toBe('done-agent')
  expect(dialog.done).toEqual(['Viewing agent'])
})

test('x on a running agent records that the user stopped it', async () => {
  const dialog = await open({
    tasks: {
      busy: { ...doneAgent, id: 'busy', agentId: 'busy', status: 'running', notified: false },
      other: { ...doneAgent, id: 'other', agentId: 'other', status: 'running', notified: false },
    },
  })
  await dialog.press('x')
  expect(state.tasks.busy).toMatchObject({ status: 'killed', stoppedByUser: true })
  expect(state.tasks.other).toMatchObject({ status: 'running' })
})

test('agents this session ran earlier are listed from disk and reopen', async () => {
  const transcript = getAgentTranscriptPath('aold1' as AgentId)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 49_000).toISOString() })}\n`,
  )
  writeFileSync(
    transcript.replace(/\.jsonl$/, '.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'beta worker' }),
  )
  const dialog = await open({ tasks: {} })
  expect(dialog.screen()).toContain('Earlier in this session (1)')
  await dialog.press('\r')
  expect(dialog.screen()).toMatch(/beta worker\s+general-purpose · started 49s ago/)
  await dialog.press('\r')
  expect(state.tasks.aold1).toMatchObject({
    type: 'local_agent',
    status: 'completed',
    description: 'beta worker',
    agentType: 'general-purpose',
    isBackgrounded: true,
    notified: true,
  })
  expect(state.viewingAgentTaskId).toBe('aold1')
  expect(dialog.done).toEqual(['Viewing agent'])
})

test('an earlier agent that ran as a forked skill reopens with the skill it may resume as', async () => {
  const agentId = 'askill1' as AgentId
  const transcript = getAgentTranscriptPath(agentId)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString() })}\n`)
  writeFileSync(
    transcript.replace(/\.jsonl$/, '.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'skill worker' }),
  )
  await persistForkedSkillScope(agentId, { skillName: 'probe-skill', attributionName: 'probe-skill' })
  const dialog = await open({ tasks: {} })
  await dialog.press('\r')
  await dialog.press('\r')
  expect(state.tasks.askill1).toMatchObject({ forkedSkillName: 'probe-skill' })
  expect(state.viewingAgentTaskId).toBe('askill1')
})

test('scheduled tasks, loop wakeups and the goal are listed', async () => {
  addSessionCronTask({ id: 'cron1', cron: '*/30 * * * *', prompt: 'CRON_PING check', createdAt: Date.now(), recurring: true })
  addSessionCronTask({ id: 'loop1', cron: '0 0 1 1 *', prompt: 'LOOP_WAKE check deploy', createdAt: Date.now(), kind: 'loop' })
  const dialog = await open({
    goalStatus: { active: true, id: 'g1', prompt: 'GOAL_COND cheese', iterations: 0, setAt: Date.now() },
  })
  const screen = dialog.screen()
  expect(screen).toContain('2 scheduled tasks')
  expect(screen).toMatch(/Scheduled\s+❯ ◯ CRON_PING check\s+Every 30 minutes\s+◯ LOOP_WAKE check deploy\s+Runs once in /)
  expect(screen).toMatch(/Goal\s+◯ GOAL_COND cheese\s+active/)
  expect(screen).toContain('x to stop')
})

test('x asks before stopping a scheduled task or the goal, and stops only that one', async () => {
  addSessionCronTask({ id: 'cron1', cron: '*/30 * * * *', prompt: 'CRON_PING check', createdAt: Date.now(), recurring: true })
  addSessionCronTask({ id: 'cron2', cron: '*/5 * * * *', prompt: 'OTHER check', createdAt: Date.now(), recurring: true })
  const dialog = await open({
    goalStatus: { active: true, id: 'g1', prompt: 'GOAL_COND cheese', iterations: 0, setAt: Date.now() },
  })
  await dialog.press('x')
  expect(dialog.screen()).toMatch(/Stop this scheduled task\?\s+CRON_PING check\s+❯ No, keep running\s+Yes, stop/)
  await dialog.press('\r')
  expect(getSessionCronTasks().map(task => task.id)).toEqual(['cron1', 'cron2'])
  await dialog.press('x')
  await dialog.press('\x1b[B')
  await dialog.press('\r')
  expect(getSessionCronTasks().map(task => task.id)).toEqual(['cron2'])
  expect(state.goalStatus.active).toBe(true)
  expect(dialog.appended.map(message => (message as { content?: unknown }).content)).toEqual([
    'Stopped scheduled task: CRON_PING check',
  ])
  expect(dialog.screen()).toContain('1 scheduled task')

  await dialog.press('\x1b[B')
  await dialog.press('x')
  expect(dialog.screen()).toMatch(/Stop the goal\?\s+GOAL_COND cheese/)
  await dialog.press('\x1b[B')
  await dialog.press('\r')
  expect(state.goalStatus.active).toBe(false)
  expect(getSessionCronTasks().map(task => task.id)).toEqual(['cron2'])
  expect(dialog.appended.map(message => (message as { content?: unknown }).content)).toContain('Goal cleared: GOAL_COND cheese')
})
