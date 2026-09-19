import { expect, mock, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import { render } from '../ink.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import type { SpinnerAnimationRowProps } from './Spinner/SpinnerAnimationRow.js'
import { TeammateSpinnerLine } from './Spinner/TeammateSpinnerLine.js'

let received: SpinnerAnimationRowProps | undefined
mock.module('./Spinner/SpinnerAnimationRow.js', () => ({
  SpinnerAnimationRow: (props: SpinnerAnimationRowProps) => {
    received = props
    return null
  },
}))
mock.module('../hooks/useSettings.js', () => ({ useSettings: () => ({}) }))
mock.module('../hooks/useTerminalSize.js', () => ({ useTerminalSize: () => ({ columns: 120, rows: 40 }) }))
const { LocalAgentSpinner } = await import('./Spinner.js')

const task = {
  id: 'alpha', type: 'local_agent', status: 'running', startTime: 1234,
  progress: { tokenCount: 350, toolUseCount: 1 },
} as LocalAgentTaskState

async function renderSpinner(element: React.ReactElement) {
  const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const instance = await render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  try {
    await new Promise(resolve => setTimeout(resolve, 30))
    return output
  } finally {
    instance.unmount()
    instance.cleanup()
  }
}

test('viewed agent spinner uses its own counters and clock', async () => {
  await renderSpinner(<LocalAgentSpinner task={task} hasActiveTools={true} verbose={true} />)
  expect(received?.loadingStartTimeRef.current).toBe(1234)
  expect(received?.responseLengthRef.current).toBe(1400)
  expect(received?.hasActiveTools).toBe(true)
  await renderSpinner(<LocalAgentSpinner task={{ ...task, id: 'beta', startTime: 5678, progress: { tokenCount: 500, toolUseCount: 2 } }} hasActiveTools={false} verbose={true} />)
  expect(received?.loadingStartTimeRef.current).toBe(5678)
  expect(received?.responseLengthRef.current).toBe(2000)
  expect(received?.hasActiveTools).toBe(false)
})

test.each(['completed', 'failed', 'killed'] as const)('no animation after %s even with unresolved tools', async status => {
  received = undefined
  await renderSpinner(<LocalAgentSpinner task={{ ...task, status }} hasActiveTools={true} verbose={false} />)
  expect(received).toBeUndefined()
})

const teammate = {
  id: 'teammate', type: 'in_process_teammate', status: 'running',
  description: 'teammate', startTime: 1_000, endTime: 6_000,
  outputFile: '', outputOffset: 0, notified: true,
  identity: { agentId: 'worker@team', agentName: 'worker', teamName: 'team', planModeRequired: false, parentSessionId: 'session' },
  prompt: 'work', awaitingPlanApproval: false, permissionMode: 'default',
  pendingUserMessages: [], isIdle: true, shutdownRequested: false,
  lastReportedToolCount: 0, lastReportedTokenCount: 0,
} as InProcessTeammateTaskState

test.each([
  ['completed', 'done'],
  ['failed', 'failed'],
  ['killed', 'stopped'],
] as const)('terminal teammate %s status is explicit and duration stays frozen', async (status, label) => {
  const output = await renderSpinner(
    <TeammateSpinnerLine
      teammate={{ ...teammate, status }}
      isLast={true}
      allIdle={true}
    />,
  )
  expect(output).toContain(`${label} for 5s`)
  expect(output).not.toContain('Idle for')
})
