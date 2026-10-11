import { expect, test } from 'bun:test'
import { selectProgramStatus, type ProgramStatusInput } from './programStatus.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js'

function status(input: Partial<ProgramStatusInput> = {}) {
  return selectProgramStatus({ sandboxPending: false, questionPending: false, busy: false, ...input })
}

test('REPL reports idle at prompt/completion/cancellation and working while loading', () => {
  expect(status()).toEqual({ state: 'idle' })
  expect(status({ busy: true })).toEqual({ state: 'working' })
  expect(status({ busy: false })).toEqual({ state: 'idle' })
})

test('sandbox and foreground or worker tools override working', () => {
  for (const input of [{ sandboxPending: true }, { pendingTool: 'Bash' }]) {
    expect(status({ ...input, busy: true })).toEqual({ state: 'blocked', kind: 'permission' })
    expect(status(input)).toEqual({ state: 'blocked', kind: 'permission' })
  }
})

test('questions and dialogs report question rather than permission', () => {
  for (const input of [{ pendingTool: ASK_USER_QUESTION_TOOL_NAME }, { questionPending: true }]) {
    expect(status({ ...input, busy: true })).toEqual({ state: 'blocked', kind: 'question' })
  }
})

test('sandbox and foreground tool permissions take precedence over question queues', () => {
  expect(status({ pendingTool: 'Bash', questionPending: true })).toEqual({ state: 'blocked', kind: 'permission' })
  expect(status({ sandboxPending: true, pendingTool: ASK_USER_QUESTION_TOOL_NAME })).toEqual({ state: 'blocked', kind: 'permission' })
})
