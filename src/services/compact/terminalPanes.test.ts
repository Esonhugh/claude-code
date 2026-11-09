import { expect, test } from 'bun:test'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { createTerminalPaneAttachmentIfNeeded } from './compact.js'

function pane(id: string, extra: Record<string, unknown> = {}) {
  return {
    id: `task-${id}`,
    type: 'interactive_terminal',
    status: 'running',
    description: id,
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    sessionId: id,
    command: '/bin/bash',
    args: [],
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    preview: '',
    closed: false,
    ...extra,
  }
}

function context(tasks: Record<string, unknown>, agentId?: string) {
  const state = { ...getDefaultAppState(), tasks }
  return { getAppState: () => state, agentId } as never
}

test('names the panes still open after compaction', () => {
  const attachment = createTerminalPaneAttachmentIfNeeded(
    context({
      a: pane('term-1', { requestedCommand: 'ssh pojun-worker' }),
      b: pane('term-2'),
      c: pane('term-3', { status: 'completed', closed: true }),
      d: pane('term-4', { agentId: 'agent-x' }),
    }),
  )
  expect(attachment?.attachment).toEqual({
    type: 'critical_system_reminder',
    content:
      'Tmux panes still open from before the summary: term-1 (ssh pojun-worker), term-2 (/bin/bash). Keep using them by target instead of opening new ones; list-panes shows their state.',
  })
})

test('a subagent sees only its own panes', () => {
  const attachment = createTerminalPaneAttachmentIfNeeded(
    context({ a: pane('term-1'), b: pane('term-4', { agentId: 'agent-x' }) }, 'agent-x'),
  )
  expect((attachment?.attachment as { content: string }).content).toContain('term-4 (/bin/bash)')
  expect((attachment?.attachment as { content: string }).content).not.toContain('term-1')
})

test('nothing when no pane is open', () => {
  expect(createTerminalPaneAttachmentIfNeeded(context({}))).toBeNull()
})
