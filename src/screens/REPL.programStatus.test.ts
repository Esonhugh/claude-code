import { expect, test } from 'bun:test'
import * as status from './programStatus.js'
import type { TaskStateBase } from '../Task.js'
import type { TaskState } from '../tasks/types.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { RemoteAgentTaskState } from '../tasks/RemoteAgentTask/RemoteAgentTask.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import type { LocalWorkflowTaskState } from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { LocalShellTaskState } from '../tasks/LocalShellTask/guards.js'

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


function taskBase(id: string): TaskStateBase {
  return { id, type: 'local_agent', status: 'running', description: `Task ${id}`, startTime: 0, outputFile: '', outputOffset: 0, notified: false }
}
function localAgent(id: string, overrides: Partial<LocalAgentTaskState> = {}): LocalAgentTaskState {
  return { ...taskBase(id), type: 'local_agent', agentId: id, prompt: '', agentType: 'general-purpose', spawnDepth: 0,
    retrieved: false, lastReportedToolCount: 0, lastReportedTokenCount: 0, isBackgrounded: true,
    pendingMessages: [], retain: false, diskLoaded: false, ...overrides }
}
function remoteAgent(id: string, overrides: Partial<RemoteAgentTaskState> = {}): RemoteAgentTaskState {
  return { ...taskBase(id), type: 'remote_agent', remoteTaskType: 'remote-agent', sessionId: id, command: '', title: '',
    todoList: [], log: [], pollStartedAt: 0, ...overrides }
}
function teammate(id: string, overrides: Partial<InProcessTeammateTaskState> = {}): InProcessTeammateTaskState {
  return { ...taskBase(id), type: 'in_process_teammate', identity: { agentId: id, agentName: id, teamName: 'team', planModeRequired: false, parentSessionId: 'parent' },
    prompt: '', awaitingPlanApproval: false, permissionMode: 'default', pendingUserMessages: [], isIdle: false,
    shutdownRequested: false, lastReportedToolCount: 0, lastReportedTokenCount: 0, ...overrides }
}
function workflow(id: string, overrides: Partial<LocalWorkflowTaskState> = {}): LocalWorkflowTaskState {
  return { ...taskBase(id), type: 'local_workflow', phases: [], results: [], events: [], ...overrides }
}
function childStatuses(...tasks: TaskState[]) {
  return status.selectChildProgramStatuses(Object.fromEntries(tasks.map((task, index) => [String(index), task])))
}

test('child records include all four agent types, even foreground, but exclude main-session, idle teammates and long-running remote agents', () => {
  const shell: LocalShellTaskState = { ...taskBase('shell'), type: 'local_bash', command: '', completionStatusSentInAttachment: false,
    shellCommand: null, lastReportedTotalLines: 0, isBackgrounded: true }
  expect(childStatuses(
    localAgent('a', { isBackgrounded: false }), remoteAgent('r'), teammate('t'), workflow('w'), shell,
    localAgent('main', { agentType: 'main-session' }), teammate('idle', { isIdle: true }), remoteAgent('long', { isLongRunning: true }),
  )).toEqual(['a', 'r', 't', 'w'].map(id => ({ id, title: `Task ${id}`, state: 'working' })))
})

test('terminal child tasks disappear; pending tasks remain visible', () => {
  expect(childStatuses(...(['completed', 'failed', 'killed'] as const).flatMap(taskStatus => [
    localAgent(`a-${taskStatus}`, { status: taskStatus }), remoteAgent(`r-${taskStatus}`, { status: taskStatus }),
    teammate(`t-${taskStatus}`, { status: taskStatus }), workflow(`w-${taskStatus}`, { status: taskStatus }),
  ]), localAgent('pending', { status: 'pending' }))).toEqual([{ id: 'pending', title: 'Task pending', state: 'working' }])
})

test('child ids are normalized, empty ids dropped, sorted before the 32-record limit', () => {
  const tasks = Array.from({ length: 35 }, (_, index) => localAgent(`a${String(34 - index).padStart(2, '0')}`))
  const capped = childStatuses(...tasks)
  expect(capped).toHaveLength(32)
  expect(capped.map(task => task.id)).toEqual(Array.from({ length: 32 }, (_, i) => `a${String(i).padStart(2, '0')}`))
  expect(childStatuses(localAgent(''), localAgent('space / 😀'), localAgent('x'.repeat(40)))).toEqual([
    { id: 'space-----', title: 'Task space / 😀', state: 'working' },
    { id: 'x'.repeat(32), title: `Task ${'x'.repeat(40)}`, state: 'working' },
  ])
})

test('ultraplan child phases map to blocked question or permission; local paused workflows use pending plus pausedAt', () => {
  expect(childStatuses(
    remoteAgent('input', { ultraplanPhase: 'needs_input' }), remoteAgent('plan', { ultraplanPhase: 'plan_ready' }),
    workflow('paused', { status: 'pending', pausedAt: 1 }), workflow('resumed', { status: 'running', pausedAt: 1 }),
    workflow('pending', { status: 'pending' }),
  )).toEqual([
    { id: 'input', title: 'Task input', state: 'blocked', kind: 'question' },
    { id: 'paused', title: 'Task paused', state: 'blocked' },
    { id: 'pending', title: 'Task pending', state: 'working' },
    { id: 'plan', title: 'Task plan', state: 'blocked', kind: 'permission' },
    { id: 'resumed', title: 'Task resumed', state: 'working' },
  ])
})
