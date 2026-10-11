import { expect, test } from 'bun:test'
import * as status from './programStatus.js'

function select(input: Partial<status.ProgramStatusInput> = {}) {
  return status.selectProgramStatus({ busy: false, queued: false, lastTurnEnd: null, signedInSinceLastTurn: false, ...input })
}

test('initial and stopped turns are idle; busy and queued idle inputs are working', () => {
  expect(select()).toEqual({ state: 'idle' })
  expect(select({ lastTurnEnd: 'stopped' })).toEqual({ state: 'idle' })
  expect(select({ busy: true })).toEqual({ state: 'working' })
  expect(select({ queued: true })).toEqual({ state: 'working' })
})

for (const [blockedOn, kind] of [
  ['permission prompt', 'permission'], ['sandbox request', 'permission'],
  ['worker request', 'permission'], ['goal proposal', 'permission'],
  ['input needed', 'question'], ['dialog open', undefined],
] as const) {
  test(`${blockedOn} maps to ${kind ?? 'no kind'} even with queued input`, () => {
    expect(select({ blockedOn, queued: true })).toEqual({ state: 'blocked', ...(kind ? { kind } : {}) })
  })
}

test('busy has official priority; caller excludes blocked UI from busy', () => {
  expect(select({ busy: true, blockedOn: 'permission prompt' })).toEqual({ state: 'working' })
  expect(select({ busy: false, blockedOn: 'permission prompt' })).toEqual({ state: 'blocked', kind: 'permission' })
})

test('completed turns remain done across unrelated prompt renders', () => {
  for (let render = 0; render < 3; render++) expect(select({ lastTurnEnd: 'completed' })).toEqual({ state: 'done' })
  expect(select({ lastTurnEnd: 'completed', busy: true })).toEqual({ state: 'working' })
})

test('API errors report their complete text, including unclassified errors', () => {
  for (const errorKind of [undefined, 'invalid_request', 'rate_limit']) {
    expect(select({ lastTurnEnd: { errorKind, failure: 'API Error: 400 forced failure' } })).toEqual({ state: 'error', msg: 'API Error: 400 forced failure' })
  }
})

for (const errorKind of ['authentication_failed', 'oauth_org_not_allowed', 'cloud_credential_error']) {
  test(`${errorKind} blocks until a successful login since that turn`, () => {
    const lastTurnEnd = { errorKind, failure: 'Please log in' }
    expect(select({ lastTurnEnd })).toEqual({ state: 'blocked', kind: 'auth', msg: 'Please log in' })
    expect(select({ lastTurnEnd, signedInSinceLastTurn: true })).toEqual({ state: 'idle' })
  })
}

test('turn completion classifies cancellation before API error, then success', () => {
  const last = { type: 'assistant', isApiErrorMessage: true, error: 'invalid_request' }
  expect(status.programTurnEnd(true, last, 'failure')).toBe('stopped')
  expect(status.programTurnEnd(false, last, 'failure')).toEqual({ errorKind: 'invalid_request', failure: 'failure' })
  expect(status.programTurnEnd(false, { type: 'assistant' })).toBe('completed')
  expect(status.programTurnEnd(false)).toBe('completed')
  expect(status.programTurnEnd(false, { ...last, error: { kind: 'authentication_failed' } }, 'failure')).toEqual({ errorKind: undefined, failure: 'failure' })
})

test('terminal failure uses the first non-empty line and unwraps the local SDK error envelope', () => {
  const last = { type: 'assistant', isApiErrorMessage: true, error: 'invalid_request' }
  expect(status.programTurnEnd(false, last, 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"forced failure"}}')).toEqual({ errorKind: 'invalid_request', failure: 'API Error: 400 forced failure' })
  expect(status.programTurnEnd(false, last, '\n  first line  \nsecond line')).toEqual({ errorKind: 'invalid_request', failure: 'first line' })
  expect(status.programTurnEnd(false, last, 'API Error: 400 {broken')).toEqual({ errorKind: 'invalid_request', failure: 'API Error: 400 {broken' })
})
