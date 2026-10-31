import { expect, test } from 'bun:test'
import type { AppState } from '../state/AppStateStore.js'
import { getBackgroundWorkOnExit } from './backgroundWorkOnExit.js'

function task(overrides: Record<string, unknown>) {
  return {
    id: 'id',
    status: 'running',
    description: 'desc',
    startTime: 1,
    notified: false,
    ...overrides,
  }
}

test('lists running agents, shells, monitors and busy teammates with official labels', () => {
  const tasks = {
    agent: task({ id: 'agent', type: 'local_agent', description: 'Run gamma timer', isBackgrounded: true }),
    shell: task({ id: 'shell', type: 'local_bash', description: 'python3 timer.py GAMMA 300', isBackgrounded: true }),
    monitor: task({ id: 'monitor', type: 'local_bash', kind: 'monitor', description: 'tail log', isBackgrounded: true }),
    mate: task({ id: 'mate', type: 'in_process_teammate', description: 'review', isIdle: false }),
  } as unknown as AppState['tasks']
  expect(getBackgroundWorkOnExit(tasks)).toEqual([
    { label: 'subagent', detail: 'Run gamma timer' },
    { label: 'shell', detail: 'python3 timer.py GAMMA 300' },
    { label: 'shell', detail: 'tail log' },
    { label: 'teammate', detail: 'review' },
  ])
})

test('skips finished, foreground, aborted and idle work', () => {
  const aborted = new AbortController()
  aborted.abort()
  const tasks = {
    done: task({ id: 'done', type: 'local_agent', status: 'completed', isBackgrounded: true }),
    fg: task({ id: 'fg', type: 'local_agent', isBackgrounded: false }),
    killed: task({ id: 'killed', type: 'local_agent', isBackgrounded: true, abortController: aborted }),
    idle: task({ id: 'idle', type: 'in_process_teammate', isIdle: true }),
    cloud: task({ id: 'cloud', type: 'remote_agent' }),
    dream: task({ id: 'dream', type: 'dream' }),
  } as unknown as AppState['tasks']
  expect(getBackgroundWorkOnExit(tasks)).toEqual([])
})

test('truncates long descriptions to one line', () => {
  const tasks = {
    long: task({ id: 'long', type: 'local_bash', isBackgrounded: true, description: 'x'.repeat(80) + '\nsecond line' }),
  } as unknown as AppState['tasks']
  const [item] = getBackgroundWorkOnExit(tasks)
  expect(item?.detail.length).toBeLessThanOrEqual(50)
  expect(item?.detail.endsWith('…')).toBe(true)
})
