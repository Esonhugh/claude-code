import { expect, test } from 'bun:test'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { createSendNow, decideSendNow, isSendNowCommand, isSendNowPrompt, type SendNowEvidence } from './sendNow.js'

const idle: SendNowEvidence = {
  turnActive: true, heldByDialog: false, compacting: false,
  runningToolUseIds: new Set(), movableToolUseIds: [], sampling: false,
}
const decide = (e: Partial<SendNowEvidence & { awaitingMovedResult: boolean; graceOver: boolean }>) =>
  decideSendNow({ ...idle, awaitingMovedResult: false, graceOver: false, ...e })

test.each([
  ['turn over', { turnActive: false, sampling: true }, { action: 'stand_by' }],
  ['permission dialog open', { heldByDialog: true, movableToolUseIds: ['t1'] }, { action: 'wait', reason: 'held_by_dialog' }],
  ['movable shell running', { runningToolUseIds: new Set(['t1']), movableToolUseIds: ['t1'] }, { action: 'background' }],
  ['compacting', { compacting: true, sampling: true }, { action: 'wait', reason: 'compacting' }],
  ['moved shell result pending', { awaitingMovedResult: true, runningToolUseIds: new Set(['t1']) }, { action: 'wait', reason: 'moved_result' }],
  ['unmovable tool in grace', { runningToolUseIds: new Set(['t1']) }, { action: 'wait', reason: 'unmovable_grace' }],
  ['unmovable tool after grace', { runningToolUseIds: new Set(['t1']), graceOver: true }, { action: 'interrupt' }],
  ['request not sampling yet', {}, { action: 'wait', reason: 'not_sampling' }],
  ['model writing', { sampling: true }, { action: 'interrupt' }],
] as const)('decideSendNow: %s', (_name, evidence, expected) => {
  expect(decide(evidence)).toEqual(expected)
})

test('only typed prompts join the running turn; typed bash and slash commands cut it', () => {
  const cmd = (c: Partial<QueuedCommand>) => ({ mode: 'prompt', value: 'hi', origin: { kind: 'human' }, ...c }) as QueuedCommand
  expect(isSendNowPrompt(cmd({}))).toBe(true)
  expect(isSendNowPrompt(cmd({ isMeta: true }))).toBe(false)
  expect(isSendNowPrompt(cmd({ value: '/cost' }))).toBe(false)
  expect(isSendNowPrompt(cmd({ mode: 'task-notification' }))).toBe(false)
  expect(isSendNowCommand(cmd({ mode: 'bash', value: 'pwd' }))).toBe(true)
  expect(isSendNowCommand(cmd({ value: '/cost' }))).toBe(true)
  expect(isSendNowCommand(cmd({}))).toBe(false)
  expect(isSendNowCommand(cmd({ mode: 'bash', isMeta: true }))).toBe(false)
})

function harness(evidence: SendNowEvidence, movable = true) {
  const log: string[] = []
  const timers: Array<() => void> = []
  let state = evidence
  let queued = true
  const sendNow = createSendNow({
    hasPrompt: () => queued,
    readEvidence: () => state,
    moveToBackground: ids => { log.push(`background ${ids.join(',')}`); return movable ? [...ids] : [] },
    interrupt: () => { log.push('interrupt') },
    schedule: run => { timers.push(run); return () => { timers.splice(timers.indexOf(run), 1) } },
  })
  const tick = () => timers.shift()!()
  return {
    sendNow, log, timers, tick,
    set: (e: Partial<SendNowEvidence>) => { state = { ...state, ...e } },
    deliver: () => { queued = false },
  }
}

test('a running shell moves to the background, then delivery waits for its result instead of cutting the turn', () => {
  const h = harness({ ...idle, runningToolUseIds: new Set(['t1']), movableToolUseIds: ['t1'] })
  h.sendNow.request()
  expect(h.log).toEqual(['background t1'])
  h.set({ movableToolUseIds: [] })
  h.tick()
  h.tick()
  expect(h.log).toEqual(['background t1'])
  h.deliver()
  h.tick()
  expect(h.timers).toEqual([])
  expect(h.log).toEqual(['background t1'])
})

test('a tool that cannot move gets a short grace, then the turn is cut', () => {
  const h = harness({ ...idle, runningToolUseIds: new Set(['t1']) })
  h.sendNow.request()
  h.tick()
  expect(h.log).toEqual([])
  h.tick()
  expect(h.log).toEqual(['interrupt'])
  expect(h.timers).toEqual([])
})

test('a shell that refuses to move falls back to cutting the turn after the grace', () => {
  const h = harness({ ...idle, runningToolUseIds: new Set(['t1']), movableToolUseIds: ['t1'] }, false)
  h.sendNow.request()
  h.tick()
  h.tick()
  expect(h.log).toEqual(['background t1', 'background t1', 'background t1', 'interrupt'])
})

test('an open permission dialog holds delivery until it closes', () => {
  const h = harness({ ...idle, heldByDialog: true, sampling: true })
  h.sendNow.request()
  h.tick()
  expect(h.log).toEqual([])
  h.set({ heldByDialog: false })
  h.tick()
  expect(h.log).toEqual(['interrupt'])
})

test('a second request while polling does not start another poll', () => {
  const h = harness({ ...idle })
  h.sendNow.request()
  h.sendNow.request()
  expect(h.timers).toHaveLength(1)
  h.sendNow.dispose()
  expect(h.timers).toEqual([])
})
