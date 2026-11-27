import { expect, test } from 'bun:test'
import type { JobRecord } from '../../daemon/protocol.js'
import { forkRows } from './forkItems.js'

function job(id: string, state: JobRecord['state'], forkParentSessionId?: string): JobRecord {
  return {
    id,
    sessionId: `${id}-session`,
    name: `name ${id}`,
    intent: '',
    cwd: '/tmp',
    args: [],
    state,
    ...(forkParentSessionId !== undefined && { forkParentSessionId }),
    createdAt: '2026-11-27T00:00:00.000Z',
    updatedAt: '2026-11-27T00:00:00.000Z',
  }
}

test('only forks of this session are listed, running ones first', () => {
  const rows = forkRows(
    [
      job('aaaa0001', 'stopped', 'parent'),
      job('aaaa0002', 'running', 'other-parent'),
      job('aaaa0003', 'running'),
      job('aaaa0004', 'running', 'parent'),
    ],
    'parent',
  )
  expect(rows).toEqual([
    { id: 'aaaa0004', label: 'name aaaa0004', status: 'running', when: 'working' },
    { id: 'aaaa0001', label: 'name aaaa0001', status: 'completed', when: 'stopped' },
  ])
})

test('a fork is labelled by the part of its name after the last ⑂, or its id', () => {
  const named = (name: string) => ({ ...job('aaaa0005', 'running', 'parent'), name })
  expect(forkRows([named('PONG reply ⑂ check the build')], 'parent')[0]!.label).toBe('check the build')
  expect(forkRows([named('a ⑂ b ⑂ c')], 'parent')[0]!.label).toBe('c')
  expect(forkRows([named('PONG reply ⑂')], 'parent')[0]!.label).toBe('aaaa0005')
})
