import { expect, test } from 'bun:test'
import { Readable, Writable } from 'node:stream'
import React from 'react'
import { render, useInput } from '../ink.js'
import { AppStoreContext, getDefaultAppState, type AppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import { useBackgroundTaskNavigation } from './useBackgroundTaskNavigation.js'
import { useTeammateViewAutoExit } from './useTeammateViewAutoExit.js'
import { dismissTerminalAgent } from '../state/teammateViewHelpers.js'

class Input extends Readable {
  isTTY = true
  isRaw = false
  _read() {}
  setRawMode(value: boolean) { this.isRaw = value; return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  columns = 100
  rows = 30
  isTTY = false
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) { callback() }
}

async function navigation({ overlay = false, footer = false, status = 'running', teammate = false, idle = false }: {
  overlay?: boolean
  footer?: boolean
  status?: LocalAgentTaskState['status']
  teammate?: boolean
  idle?: boolean
} = {}) {
  const abortController = new AbortController()
  const task = {
    id: 'agent-navigation', type: 'local_agent', agentId: 'agent-navigation', agentType: 'Explore',
    status, abortController, startTime: Date.now(), description: 'Read source',
    retain: true, pendingMessages: [], notified: false,
  } as LocalAgentTaskState
  const currentWorkAbortController = new AbortController()
  const viewedTask = teammate ? {
    ...task, type: 'in_process_teammate',
    identity: { agentName: 'worker', agentId: 'worker@team', teamName: 'team' },
    isIdle: idle,
    currentWorkAbortController: idle ? undefined : currentWorkAbortController,
  } as unknown as InProcessTeammateTaskState : task
  const store = createStore<AppState>({
    ...getDefaultAppState(),
    tasks: {
      [task.id]: viewedTask,
      other: { ...task, id: 'other', agentId: 'other', status: 'running' as const, abortController: new AbortController() },
    },
    footerSelection: footer ? 'tasks' as const : null,
    viewingAgentTaskId: task.id,
    viewSelectionMode: 'viewing-agent' as const,
    activeOverlays: new Set(overlay ? ['navigation-test-dialog'] : []),
  })
  const observedKeys: string[] = []
  function Harness() {
    useBackgroundTaskNavigation()
    useTeammateViewAutoExit()
    useInput((_input, key) => { if (key.escape) observedKeys.push('escape') })
    return null
  }
  const stdin = new Input()
  const instance = await render(
    <AppStoreContext.Provider value={store}><Harness /></AppStoreContext.Provider>,
    { stdin: stdin as unknown as NodeJS.ReadStream, stdout: new Output() as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false },
  )
  await new Promise(resolve => setTimeout(resolve, 30))
  return {
    store, abortController, currentWorkAbortController, observedKeys,
    async escape() { stdin.push('\u001b'); await new Promise(resolve => setTimeout(resolve, 100)) },
    close() { instance.unmount(); instance.cleanup() },
  }
}

test('Escape stops only the viewed local agent before returning from its terminal transcript', async () => {
  const h = await navigation()
  try {
    await h.escape()
    expect(h.abortController.signal.aborted).toBe(true)
    expect(h.store.getState().tasks['agent-navigation']?.status).toBe('killed')
    expect(h.store.getState().tasks.other?.status).toBe('running')
    expect((h.store.getState().tasks.other as LocalAgentTaskState).abortController?.signal.aborted).toBe(false)
    expect(h.store.getState().viewingAgentTaskId).toBe('agent-navigation')
    expect(h.observedKeys).toEqual([])
    await h.escape()
    expect(h.store.getState().viewingAgentTaskId).toBeUndefined()
  } finally { h.close() }
})

test.each([false, true])('teammate Escape interrupts only active work (idle=%s)', async idle => {
  const h = await navigation({ teammate: true, idle })
  try {
    await h.escape()
    expect(h.currentWorkAbortController.signal.aborted).toBe(!idle)
    expect(h.abortController.signal.aborted).toBe(false)
    expect(h.store.getState().tasks['agent-navigation']?.status).toBe('running')
    expect(h.store.getState().viewingAgentTaskId).toBe('agent-navigation')
    expect(h.observedKeys).toEqual([])
  } finally { h.close() }
})

test.each(['completed', 'killed', 'failed'] as const)('terminal teammate transcript stays open until Escape (%s)', async status => {
  const h = await navigation({ teammate: true, status })
  try {
    expect(h.store.getState().viewingAgentTaskId).toBe('agent-navigation')
    const viewed = h.store.getState().tasks['agent-navigation']
    if (viewed?.type !== 'in_process_teammate') throw new Error('Expected teammate')
    expect(viewed.retain).toBe(true)
    await h.escape()
    expect(h.store.getState().viewingAgentTaskId).toBeUndefined()
    const released = h.store.getState().tasks['agent-navigation']
    if (released?.type !== 'in_process_teammate') throw new Error('Expected teammate')
    expect(released.status).toBe(status)
    expect(released.evictAfter).toBeGreaterThan(Date.now())
    expect(h.observedKeys).toEqual([])
  } finally { h.close() }
})

test('viewed teammate failure preserves the view and error until explicit dismissal', async () => {
  const h = await navigation({ teammate: true })
  try {
    h.store.setState(prev => ({
      ...prev,
      tasks: {
        ...prev.tasks,
        'agent-navigation': {
          ...prev.tasks['agent-navigation']!,
          status: 'failed',
          error: 'runner boom',
        },
      },
    }))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.store.getState().viewingAgentTaskId).toBe('agent-navigation')
    expect((h.store.getState().tasks['agent-navigation'] as InProcessTeammateTaskState).error).toBe('runner boom')
    dismissTerminalAgent('agent-navigation', h.store.setState)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.store.getState().viewingAgentTaskId).toBeUndefined()
    const dismissed = h.store.getState().tasks['agent-navigation']
    if (dismissed?.type !== 'in_process_teammate') throw new Error('Expected teammate')
    expect(dismissed.evictAfter).toBe(0)
  } finally { h.close() }
})

test.each([false, true])('removing a viewed task returns to main (teammate=%s)', async teammate => {
  const h = await navigation({ teammate })
  try {
    h.store.setState(prev => ({ ...prev, tasks: { other: prev.tasks.other! } }))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.store.getState().viewingAgentTaskId).toBeUndefined()
    expect(h.store.getState().viewSelectionMode).toBe('none')
    expect(h.store.getState().tasks.other?.status).toBe('running')
  } finally { h.close() }
})

test('Escape consumed by Agent navigation does not reach other input handlers', async () => {
  const h = await navigation({ status: 'completed' })
  try {
    await h.escape()
    expect(h.store.getState().viewingAgentTaskId).toBeUndefined()
    expect(h.observedKeys).toEqual([])
  } finally { h.close() }
})

test('footer selection owns Escape without stopping the viewed agent', async () => {
  const h = await navigation({ footer: true })
  try {
    await h.escape()
    expect(h.abortController.signal.aborted).toBe(false)
    expect(h.store.getState().viewingAgentTaskId).toBe('agent-navigation')
    expect(h.observedKeys).toEqual(['escape'])
  } finally { h.close() }
})

test('modal Escape leaves the viewed agent and its work untouched', async () => {
  const h = await navigation({ overlay: true })
  try {
    await h.escape()
    expect(h.abortController.signal.aborted).toBe(false)
    expect(h.store.getState().viewingAgentTaskId).toBe('agent-navigation')
    expect(h.observedKeys).toEqual(['escape'])
  } finally { h.close() }
})
