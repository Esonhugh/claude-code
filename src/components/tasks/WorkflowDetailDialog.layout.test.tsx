import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { ModalContext } from '../../context/modalContext.js'
import { Box, render } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { WorkflowDetailDialog } from './WorkflowDetailDialog.js'

const workflow = {
  id: 'w1',
  type: 'local_workflow',
  status: 'running',
  description: 'two parallel counts then a merge',
  workflowName: 'parity-slow',
  meta: { name: 'parity-slow', description: 'two parallel counts then a merge', phases: [{ title: 'Count' }, { title: 'Merge' }] },
  agentCount: 2,
  tokenCount: 0,
  startTime: 1_000,
  outputFile: '/tmp/w1.output',
  outputOffset: 0,
  notified: false,
  phases: [
    { id: 'Count', status: 'running', agentIds: ['count:calc', 'count:readme'], completedAgentIds: ['count:calc'], skippedAgentIds: [], failedAgentIds: [], results: [] },
    { id: 'Merge', status: 'pending', agentIds: [], completedAgentIds: [], skippedAgentIds: [], failedAgentIds: [], results: [] },
  ],
  results: [],
  events: [],
} as unknown as LocalWorkflowTaskState

async function lastFrame(columns: number, rows: number, inModal: boolean): Promise<string[]> {
  const stdout = Object.assign(new PassThrough(), { columns, rows, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const dialog = <WorkflowDetailDialog workflow={workflow} onBack={() => {}} />
  const instance = await render(
    <AppStateProvider>
      <KeybindingSetup>
        {inModal ? (
          // As FullscreenLayout's modal slot: inset by paddingX={2}, its size given by ModalContext.
          <Box flexDirection="column" paddingX={2}>
            <ModalContext value={{ rows: rows - 3, columns: columns - 4, scrollRef: null }}>{dialog}</ModalContext>
          </Box>
        ) : dialog}
      </KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    const frames = output.split('\x1B[?2026h').filter(f => f.includes('╭'))
    return stripAnsi(frames.at(-1) ?? '').split('\x1B[?2026l')[0]!.split('\n')
  } finally {
    instance.unmount()
    instance.cleanup()
  }
}

// A panel row wider than the space it has wraps: every row then takes two lines and the hints go off screen.
test.each([
  [80, false],
  [180, false],
  [80, true],
  [120, true],
  [180, true],
])('the panel fits a %i-column terminal (in the modal: %p)', async (columns, inModal) => {
  const lines = await lastFrame(columns, 50, inModal)
  for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(columns)
  const top = lines.findIndex(l => l.includes('╭'))
  const bottom = lines.findIndex(l => l.includes('╰'))
  expect(top).toBeGreaterThanOrEqual(0)
  expect(bottom).toBeGreaterThan(top)
  for (const line of lines.slice(top + 1, bottom)) expect(line).toContain('│')
  expect(lines.some(l => l.includes('esc back'))).toBe(true)
  // The modal draws its own ▔ divider above, as official does, so the dialog adds no rule of its own there.
  expect(lines.some(l => l.includes('────') && !l.includes('╭') && !l.includes('╰'))).toBe(!inModal)
  // As official 2.1.329: title and description, a blank, the panel, a blank, the hints.
  const title = lines.findIndex(l => l.includes('parity-slow'))
  expect(lines.slice(title, top + 1).map(l => l.trim() === '' ? '' : 'x')).toEqual(['x', 'x', '', 'x'])
  expect(lines.slice(bottom, bottom + 3).map(l => l.trim() === '' ? '' : l.includes('esc back') ? 'hints' : 'x')).toEqual(['x', '', 'hints'])
  // In the modal the panel fills its height as official does: the modal is `rows - 3` tall and the panel leaves one row spare.
  if (inModal) expect(bottom + 2 - title + 1).toBe(46)
})
