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
    expect(select({ blockedOn, queued: true })).toEqual({ state: 'blocked', ...(kind ? { kind } : {}), msg: blockedOn })
  })
}

test('busy has official priority; caller excludes blocked UI from busy', () => {
  expect(select({ busy: true, blockedOn: 'permission prompt' })).toEqual({ state: 'working' })
  expect(select({ busy: false, blockedOn: 'permission prompt' })).toEqual({ state: 'blocked', kind: 'permission', msg: 'permission prompt' })
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


test('permission messages retain full Bash commands, file paths and URLs', () => {
  const tool = { name: 'Bash', userFacingName: () => ' Bash ' }
  expect(status.programStatusAskText(tool, { command: 'echo hi > /private/tmp/outside.txt' })).toBe('approve Bash: echo hi > /private/tmp/outside.txt')
  expect(status.programStatusAskText({ ...tool, name: 'Read', userFacingName: () => '' }, { file_path: '/work/a b.ts' })).toBe('approve Read: /work/a b.ts')
  expect(status.programStatusAskText({ ...tool, userFacingName: () => 'WebFetch' }, { url: 'https://example.test/a?secret=value' })).toBe('approve WebFetch: https://example.test/a?secret=value')
  expect(status.programStatusAskText(tool, { command: 2, file_path: '/fallback' })).toBe('approve Bash: /fallback')
  expect(status.programStatusAskText({ ...tool, userFacingName: () => 'Bash echo hi' }, { command: 'echo hi' })).toBe('approve Bash echo hi')
})

test('permission text squashes whitespace and truncates at 800 UTF-16 units with ellipsis', () => {
  const tool = { name: 'Bash', userFacingName: () => 'Bash' }
  expect(status.programStatusAskText(tool, { command: '  echo\n\thi  ' })).toBe('approve Bash: echo hi')
  const text = status.programStatusAskText(tool, { command: 'x'.repeat(1000) })
  expect(text).toBe('approve Bash: ' + 'x'.repeat(785) + '…')
  const emoji = status.programStatusAskText(tool, { command: 'x'.repeat(784) + '😀'.repeat(5) })
  expect(emoji).toBe('approve Bash: ' + 'x'.repeat(784) + '…')
})

test('AskUserQuestion and ExitPlanMode use official author-facing text', () => {
  const question = { name: 'AskUserQuestion', userFacingName: () => '' }
  expect(status.programStatusAskText(question, { questions: [{ question: 'Pick one?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] })).toBe('answer: Pick one? (Alpha · Beta)')
  expect(status.programStatusAskText(question, {})).toBe('answer question')
  expect(status.programStatusAskText(question, { questions: [{ bad: true }, { question: 'Choose?' }] })).toBe('answer: Choose?')
  expect(status.programStatusAskText({ name: 'ExitPlanMode', userFacingName: () => '' }, {})).toBe('approve plan')
})

test('sandbox, worker, MCP, and dialog messages use their blocking sources', () => {
  expect(status.programStatusBlockedText({ blockedOn: 'sandbox request', sandboxHost: 'api.example.test' })).toBe('allow network: api.example.test')
  expect(status.programStatusBlockedText({ blockedOn: 'worker request', worker: { toolName: 'Read', description: 'read\nfile' } })).toBe('approve Read: read file')
  expect(status.programStatusBlockedText({ blockedOn: 'input needed', elicitationServer: 'server' })).toBe('MCP input: server')
  expect(status.programStatusBlockedText({ blockedOn: 'input needed', askText: 'answer: Choose?' })).toBe('answer: Choose?')
  expect(select({ blockedOn: 'dialog open' })).toEqual({ state: 'blocked', msg: 'dialog open' })
})

test('task-list progress is absent for no tasks and counts completed tasks only', () => {
  expect(status.programStatusProgress(undefined)).toBeUndefined()
  expect(status.programStatusProgress([])).toBeUndefined()
  expect(status.programStatusProgress([{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }])).toBe(100 / 3)
  expect(select({ busy: true, progress: 50 })).toMatchObject({ state: 'working', progress: 50 })
  expect(select({ blockedOn: 'permission prompt', progress: 50, blockedText: 'approve Bash: echo hi' })).toEqual({ state: 'blocked', kind: 'permission', progress: 50, msg: 'approve Bash: echo hi' })
})
