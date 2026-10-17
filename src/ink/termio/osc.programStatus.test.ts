import { afterEach, beforeEach, expect, test } from 'bun:test'
import { env } from '../../utils/env.js'
import * as osc from './osc.js'

const savedTerminal = env.terminal
const b64 = (text: string) => Buffer.from(text).toString('base64')
beforeEach(() => { env.terminal = 'xterm' })
afterEach(() => { env.terminal = savedTerminal })

// Official 2.1.296 encoder $cr; BEL captures in psp-runs/official-296/psp.log.
test('root records omit id and encode fields in official order', () => {
  for (const state of ['idle', 'working', 'done', 'error'] as const) {
    expect(osc.programStatus({ state })).toBe(`\x1b]7501;state=${state}:app=claude-code\x07`)
  }
  for (const kind of ['permission', 'question', 'auth'] as const) {
    expect(osc.programStatus({ state: 'blocked', kind })).toBe(`\x1b]7501;state=blocked:app=claude-code:kind=${kind}\x07`)
  }
  expect(osc.programStatus({ state: 'blocked', kind: 'permission', progress: 49.6, title: 'Task', msg: 'approve Bash: echo hi', id: 'task-1' })).toBe(
    `\x1b]7501;state=blocked:app=claude-code:id=task-1:kind=permission:progress=50:title=${b64('Task')}:msg=${b64('approve Bash: echo hi')}\x07`,
  )
})

test('kind is blocked-only and finite progress is working/blocked-only', () => {
  expect(osc.programStatus({ state: 'done', kind: 'auth' })).not.toContain('kind=')
  expect(osc.programStatus({ state: 'idle', progress: 50 })).not.toContain('progress=')
  for (const progress of [NaN, Infinity, -Infinity]) expect(osc.programStatus({ state: 'working', progress })).not.toContain('progress=')
  expect(osc.programStatus({ state: 'working', progress: 140.4 })).toContain(':progress=100')
  expect(osc.programStatus({ state: 'blocked', progress: -3 })).toContain(':progress=0')
})

test('control characters become spaces before base64 encoding', () => {
  expect(osc.programStatus({ state: 'working', msg: 'a\x1b[31mb\nc\x7f\x9f', title: 'x\ty' })).toBe(
    `\x1b]7501;state=working:app=claude-code:title=${b64('x y')}:msg=${b64('a [31mb c  ')}\x07`,
  )
})

test('UTF-8 title and message limits retain only complete code points', () => {
  const sequence = osc.programStatus({ state: 'working', title: '😀'.repeat(100), msg: '汉'.repeat(1000) })
  const title = Buffer.from(/:title=([^:]+)/.exec(sequence)![1]!, 'base64')
  // eslint-disable-next-line no-control-regex
  const msg = Buffer.from(/:msg=([^\x07]+)/.exec(sequence)![1]!, 'base64')
  expect(title.toString()).toBe('😀'.repeat(48))
  expect(msg.toString()).toBe('汉'.repeat(682))
})

test('child ids normalize and truncate; empty ids are discarded by the selector', () => {
  expect(osc.programStatusId('task/1 é')).toBe('task-1--')
  expect(osc.programStatusId('a'.repeat(40))).toBe('a'.repeat(32))
  expect(osc.programStatusId('')).toBeUndefined()
})

test('kitty uses ST for records; global clear always uses BEL', () => {
  env.terminal = 'kitty'
  expect(osc.programStatus({ state: 'idle' })).toBe('\x1b]7501;state=idle:app=claude-code\x1b\\')
  expect(osc.clearProgramStatus('task-1')).toBe('\x1b]7501;state=clear:id=task-1\x1b\\')
  expect(osc.CLEAR_ALL_PROGRAM_STATUS).toBe('\x1b]7501;state=clear\x07')
})
