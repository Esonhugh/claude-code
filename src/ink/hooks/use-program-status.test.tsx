import { afterEach, beforeEach, expect, test } from 'bun:test'
import React, { act } from 'react'
import { PassThrough } from 'node:stream'
import render from '../root.js'
import { useProgramStatus } from './use-program-status.js'
import { env } from '../../utils/env.js'
import {
  CLEAR_ALL_PROGRAM_STATUS,
  programStatus,
  type ProgramStatus,
  wrapForMultiplexer,
} from '../termio/osc.js'
import {
  TerminalWriteProvider,
  type TerminalWriter,
} from '../useTerminalNotification.js'

const savedTerminal = env.terminal
const savedTmux = process.env.TMUX
const savedScreen = process.env.STY
const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
let savedActEnvironment: boolean | undefined
beforeEach(() => {
  env.terminal = 'xterm'
  savedActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => {
  env.terminal = savedTerminal
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = savedActEnvironment
  if (savedTmux === undefined) delete process.env.TMUX
  else process.env.TMUX = savedTmux
  if (savedScreen === undefined) delete process.env.STY
  else process.env.STY = savedScreen
})

function Status({ status }: { status: ProgramStatus }) {
  useProgramStatus(status)
  return null
}

async function mountStatus(isTTY: boolean) {
  const writes: string[] = []
  const terminal: TerminalWriter = {
    isTTY,
    write: data => writes.push(data),
  }
  const stdout = Object.assign(new PassThrough(), {
    columns: 80,
    rows: 24,
    isTTY: false,
  })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: false,
    setRawMode() {},
  })
  const tree = (status: ProgramStatus) => (
    <TerminalWriteProvider value={terminal}>
      <Status status={status} />
    </TerminalWriteProvider>
  )
  let instance!: Awaited<ReturnType<typeof render>>
  await act(async () => {
    instance = await render(tree({ state: 'idle' }), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    })
  })
  return {
    writes,
    async update(status: ProgramStatus) {
      await act(async () => {
        instance.rerender(tree(status))
      })
    },
    async close() {
      await act(async () => {
        instance.unmount()
      })
      instance.cleanup()
    },
  }
}

test('TTY reports transitions once, removes stale kind, and clears all reported records on unmount', async () => {
  delete process.env.TMUX
  delete process.env.STY
  const app = await mountStatus(true)
  try {
    await app.update({ state: 'idle' })
    await app.update({ state: 'working' })
    await app.update({ state: 'blocked', kind: 'permission' })
    await app.update({ state: 'blocked', kind: 'permission' })
    await app.update({ state: 'blocked', kind: 'question' })
    await app.update({ state: 'working' })
    await app.update({ state: 'idle' })
    expect(app.writes).toEqual([
      programStatus({ state: 'idle' }),
      programStatus({ state: 'working' }),
      programStatus({ state: 'blocked', kind: 'permission' }),
      programStatus({ state: 'blocked', kind: 'question' }),
      programStatus({ state: 'working' }),
      programStatus({ state: 'idle' }),
    ])
  } finally {
    await app.close()
  }
  expect(app.writes.at(-1)).toBe(CLEAR_ALL_PROGRAM_STATUS)
})

test('non-TTY output contains neither status reports nor cleanup', async () => {
  const app = await mountStatus(false)
  try {
    await app.update({ state: 'working' })
    await app.update({ state: 'blocked', kind: 'question' })
    await app.update({ state: 'idle' })
  } finally {
    await app.close()
  }
  expect(app.writes).toEqual([])
})

test('tmux and screen reports and cleanup use existing multiplexer passthrough', async () => {
  for (const multiplexer of ['TMUX', 'STY'] as const) {
    delete process.env.TMUX
    delete process.env.STY
    process.env[multiplexer] = 'osc7501-test'
    const app = await mountStatus(true)
    try {
      expect(app.writes).toEqual([
        wrapForMultiplexer(programStatus({ state: 'idle' })),
      ])
      expect(app.writes[0]).toStartWith(
        multiplexer === 'TMUX' ? '\x1bPtmux;' : '\x1bP',
      )
      if (multiplexer === 'STY') {
        // Screen terminates DCS at the first ST: the inner OSC must use BEL.
        expect(app.writes[0]).toEndWith('\x07\x1b\\')
        expect(app.writes[0]!.split('\x1b\\')).toHaveLength(2)
      }
    } finally {
      await app.close()
    }
    expect(app.writes.at(-1)).toBe(wrapForMultiplexer(CLEAR_ALL_PROGRAM_STATUS))
  }
})
