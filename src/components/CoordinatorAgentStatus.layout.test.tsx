import { expect, test } from 'bun:test'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { render } from '../ink.js'
import { stringWidth } from '../ink/stringWidth.js'
import { AppStoreContext, getDefaultAppState, type AppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { CoordinatorTaskPanel } from './CoordinatorAgentStatus.js'

class Output extends Writable {
  rows = 40
  isTTY = false
  output = ''
  constructor(readonly columns: number) { super() }
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.output += chunk.toString()
    callback()
  }
}

async function panelLines(columns: number, verbose = false, overrides: Partial<AppState> = {}) {
  const agent = (id: string, overrides: Partial<LocalAgentTaskState>): LocalAgentTaskState => ({
    id, type: 'local_agent', status: 'running', agentId: id,
    agentType: id, description: 'Read source', prompt: 'Read source',
    startTime: Date.now() - 5_000, outputFile: '', outputOffset: 0, notified: false,
    progress: { tokenCount: 1500, toolUseCount: 2, lastActivity: { activityDescription: 'Reading source files' } },
    ...overrides,
  } as LocalAgentTaskState)
  const store = createStore({
    ...getDefaultAppState(),
    verbose,
    tasks: {
      Explore: agent('Explore', {}),
      'general-purpose': agent('general-purpose', {
        description: 'A considerably longer task description',
        startTime: Date.now() - 65_000,
        progress: { tokenCount: 22800, toolUseCount: 17, lastActivity: { activityDescription: 'Finding src/**/*{Coordinator,coordinator,Teammate,teammate}* files' } } as LocalAgentTaskState['progress'],
      }),
    },
    ...overrides,
  })
  const stdout = new Output(columns)
  const instance = await render(
    <AppStoreContext.Provider value={store}><CoordinatorTaskPanel /></AppStoreContext.Provider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    await new Promise(resolve => setTimeout(resolve, 40))
    return stripAnsi(stdout.output).split('\n').filter(line => line.trim())
  } finally {
    instance.unmount()
    instance.cleanup()
  }
}

test.each([100, 180])('Agent statistics align across rows at %s columns', async columns => {
  const lines = await panelLines(columns)
  const alpha = lines.find(line => line.includes('Explore'))!
  const beta = lines.find(line => line.includes('general-purpose'))!
  expect(alpha).toBeDefined()
  expect(beta).toBeDefined()
  expect(alpha).toContain('1.5k')
  expect(beta).toContain('22.8k')
  expect(alpha.indexOf('tok')).toBe(beta.indexOf('tok'))
  expect(alpha).not.toContain('tools')
  expect(beta).not.toContain('running')
  expect(alpha.indexOf('Read source')).toBe(beta.indexOf('A considerably'))
  expect(lines.every(line => stringWidth(line) <= columns)).toBe(true)
})

test('selected running Agent advertises stop, but its steering input does not', async () => {
  const selected = { footerSelection: 'tasks' as const, coordinatorTaskIndex: 2 }
  const lines = await panelLines(100, false, selected)
  expect(lines.some(line => line.includes('Enter to view') && line.includes('x to stop'))).toBe(true)
  const viewed = await panelLines(100, false, { ...selected, viewingAgentTaskId: 'Explore' })
  expect(viewed.some(line => line.includes('x to stop'))).toBe(false)
})

test('selected terminal Agent advertises clear', async () => {
  const tasks = {
    stopped: {
      id: 'stopped', type: 'local_agent', status: 'killed', agentId: 'stopped',
      agentType: 'Explore', description: 'Read source', startTime: 1_000, endTime: 3_000,
    },
  } as unknown as AppState['tasks']
  const lines = await panelLines(100, false, { tasks, footerSelection: 'tasks', coordinatorTaskIndex: 1 })
  expect(lines.some(line => line.includes('x to clear'))).toBe(true)
  expect(lines.some(line => line.includes('x to stop'))).toBe(false)
})

test.each([110, 180])('verbose Agent metrics and activity align at %s columns', async columns => {
  const lines = await panelLines(columns, true)
  const alpha = lines.find(line => line.includes('Explore'))!
  const beta = lines.find(line => line.includes('general-purpose'))!
  expect(alpha).toBeDefined()
  expect(beta).toBeDefined()
  expect(alpha).toContain('2 tools')
  expect(beta).toContain('17 tools')
  expect(alpha.indexOf('Reading')).toBe(beta.indexOf('Finding'))
  expect(alpha.indexOf('running')).toBe(beta.indexOf('running'))
  expect(alpha.indexOf('tools')).toBe(beta.indexOf('tools'))
  expect(alpha.indexOf(' · ')).toBe(beta.indexOf(' · '))
  expect(alpha.indexOf('tokens')).toBe(beta.indexOf('tokens'))
  expect(lines).toHaveLength(3)
  expect(lines.every(line => stringWidth(line) <= columns)).toBe(true)
})

test('mixed workflow panel retains progress and status without exposing default agent tools', async () => {
  const tasks = {
    agent: {
      id: 'agent', type: 'local_agent', status: 'running', agentId: 'agent',
      agentType: 'Explore', description: 'Read source', startTime: Date.now() - 5_000,
      progress: { tokenCount: 1500, toolUseCount: 2 },
    },
    workflow: {
      id: 'workflow', type: 'local_workflow', status: 'completed',
      workflowName: 'review', description: 'Review source', startTime: 1_000, endTime: 3_000,
      tokenCount: 22800, agentCount: 2, phases: [], results: [],
    },
  } as unknown as AppState['tasks']
  const lines = await panelLines(100, false, { tasks })
  const agent = lines.find(line => line.includes('Explore'))!
  const workflow = lines.find(line => line.includes('review'))!
  expect(agent).not.toContain('tools')
  expect(agent).not.toContain('running')
  expect(workflow).toContain('0/2 agents')
  expect(workflow).toContain('done')
  expect(agent.indexOf('tokens')).toBe(workflow.indexOf('tokens'))
  expect(lines).toHaveLength(3)
  expect(lines.every(line => stringWidth(line) <= 100)).toBe(true)
})

test.each([20, 50, 64])('narrow Agent panel stays within %s columns', async columns => {
  const lines = await panelLines(columns)
  expect(lines.some(line => line.includes('Explore'))).toBe(true)
  expect(lines).toHaveLength(3)
  expect(lines.every(line => stringWidth(line) <= columns)).toBe(true)
})

test('narrow Agent panel retains names without wrapping metrics into another row', async () => {
  const lines = await panelLines(50)
  expect(lines.some(line => line.includes('Explore'))).toBe(true)
  expect(lines.some(line => line.includes('general-purpose'))).toBe(true)
  expect(lines).toHaveLength(3)
  expect(lines.every(line => stringWidth(line) <= 50)).toBe(true)
})
