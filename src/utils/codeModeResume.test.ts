import { describe, expect, test } from 'bun:test'
import type { Message } from '../types/message.js'
import {
  CODE_MODE_TAKEN_OUT_NOTICE,
  codeModeOffReminder,
  inferCodeModeFromMessages,
  planCodeModeResume,
} from './codeModeResume.js'
import { createAssistantMessage, createUserMessage, REJECT_MESSAGE } from './messages.js'

function use(id: string, name: string, isVirtual?: true): Message {
  return createAssistantMessage({ content: [{ type: 'tool_use', id, name, input: {} }] as never, isVirtual })
}
function result(id: string, content: string, isError?: boolean): Message {
  return createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }],
  })
}

describe('inferCodeModeFromMessages', () => {
  test('a REPL call answered with <repl-output> means Code Mode', () => {
    expect(inferCodeModeFromMessages([use('t1', 'REPL'), result('t1', '<repl-output>\n<result>1</result>\n</repl-output>')])).toBe(true)
  })

  test('a later answered Read call means ordinary tools', () => {
    const messages = [use('t1', 'REPL'), result('t1', '<repl-output></repl-output>'), use('t2', 'Read'), result('t2', 'file')]
    expect(inferCodeModeFromMessages(messages)).toBe(false)
  })

  test('virtual pairs, refused and rejected calls say nothing', () => {
    const messages = [
      use('repl_1', 'Read', true),
      result('repl_1', ''),
      use('t2', 'Read'),
      result('t2', '<tool_use_error>Error: No such tool available: Read</tool_use_error>', true),
      use('t3', 'Bash'),
      result('t3', REJECT_MESSAGE, true),
      use('t4', 'REPL'),
      result('t4', 'plain text'),
    ]
    expect(inferCodeModeFromMessages(messages)).toBeUndefined()
  })
})

describe('planCodeModeResume', () => {
  const codeModeTranscript = [use('t1', 'REPL'), result('t1', '<repl-output></repl-output>')]

  test('a session that never ran Code Mode is left alone', () => {
    expect(planCodeModeResume(undefined, [], false)).toEqual({ replMode: undefined, messages: [] })
    expect(planCodeModeResume(false, codeModeTranscript, false)).toEqual({ replMode: false, messages: [] })
  })

  test('Code Mode on keeps it on, recorded or inferred', () => {
    expect(planCodeModeResume(true, [], true)).toEqual({ replMode: true, messages: [] })
    expect(planCodeModeResume(undefined, codeModeTranscript, true)).toEqual({ replMode: true, messages: [] })
  })

  test('Code Mode off injects the official reminder and records false', () => {
    const plan = planCodeModeResume(true, [], false)
    expect(plan.replMode).toBe(false)
    const [reminder, notice] = plan.messages as [Message, Message]
    expect(reminder).toMatchObject({ type: 'user', isMeta: true })
    const text = (reminder as { message: { content: string } }).message.content
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('Code Mode is off in this session.\n- Do not call REPL or Poll.')
    expect(text).toContain(codeModeOffReminder())
    expect(notice).toMatchObject({ type: 'system', level: 'warning', content: CODE_MODE_TAKEN_OUT_NOTICE })
    expect(planCodeModeResume(undefined, codeModeTranscript, false).replMode).toBe(false)
  })
})

describe('the Code Mode taken-out texts', () => {
  test('the notice names Code Mode (experimental), as 2.1.325', () => {
    expect(CODE_MODE_TAKEN_OUT_NOTICE).toBe(
      "This session was started in Code Mode (experimental), which isn't available where it runs now. It continues with the ordinary tools and stays out of Code Mode from now on.",
    )
  })

  test('the reminder lists each dispatched eval whose outcome never arrived', () => {
    const messages = [
      use('t1', 'REPL'),
      result('t1', '(dispatched #1)'),
      use('t2', 'REPL'),
      result('t2', '(dispatched #2)'),
      use('p1', 'Poll'),
      result('p1', '<event kind="repl-eval" at="2026-11-16T00:00:00.000Z" eval="1" ms="5" status="ok">done</event>'),
    ]
    const text = (planCodeModeResume(true, messages, false).messages[0] as { message: { content: string } }).message
      .content
    expect(text).toContain(
      '- The variables and functions that your earlier scripts defined are gone.\n- eval #2 never settled: the process that was running it exited. Its result is lost and the script is no longer running; a command it had started may have run on.\n- If this conversation',
    )
    expect(text).not.toContain('eval #1 never settled')
  })
})
