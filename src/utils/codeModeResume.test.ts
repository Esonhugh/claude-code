import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { getIsInteractive, setIsInteractive } from '../bootstrap/state.js'
import { noteReplLaunchPermissionMode, resetCodeModeGateForTesting } from '../tools/REPLTool/codeModeGate.js'
import { releaseAllReplSessions } from '../tools/REPLTool/sessions.js'
import type { Message } from '../types/message.js'
import {
  CODE_MODE_TAKEN_OUT_NOTICE,
  codeModeOffReminder,
  inferCodeModeFromMessages,
  planCodeModeResume,
  reportLostReplEvals,
} from './codeModeResume.js'
import { getCommandQueueSnapshot, pollEventWakes, resetCommandQueue } from './messageQueueManager.js'
import { createAssistantMessage, createUserMessage, REJECT_MESSAGE } from './messages.js'
import {
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from './settings/settingsCache.js'

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

describe('reportLostReplEvals (official qKa)', () => {
  const savedCodeMode = process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE
  const savedEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
  const savedInteractive = getIsInteractive()
  const originalSettings = getSessionSettingsCache()
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  beforeAll(() => {
    setSessionSettingsCache({ settings: {}, errors: [] })
    for (const source of ['userSettings', 'projectSettings', 'localSettings', 'policySettings', 'flagSettings'] as const)
      setCachedSettingsForSource(source, {})
    process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    setIsInteractive(true)
  })
  afterEach(() => {
    releaseAllReplSessions()
    resetCommandQueue()
    resetCodeModeGateForTesting()
  })
  afterAll(() => {
    restore('CLAUDE_CODE_EXPERIMENTAL_CODE_MODE', savedCodeMode)
    restore('CLAUDE_CODE_ENTRYPOINT', savedEntrypoint)
    setIsInteractive(savedInteractive)
    resetSettingsCache()
    if (originalSettings) setSessionSettingsCache(originalSettings)
  })

  const earlier = (message: Message): Message => ({ ...message, timestamp: '2020-01-01T00:00:00.000Z' }) as Message
  const events = () => getCommandQueueSnapshot().filter(cmd => cmd.mode === 'poll-event')

  test('each eval an earlier process left unsettled gets a lost event and a row', async () => {
    noteReplLaunchPermissionMode('bypassPermissions')
    const rows = await reportLostReplEvals([
      use('t1', 'REPL'),
      earlier(result('t1', '(dispatched #1)')),
      use('t2', 'REPL'),
      earlier(result('t2', '(dispatched #2)')),
      use('p1', 'Poll'),
      result('p1', '<event kind="repl-eval" at="2026-11-16T00:00:00.000Z" eval="1" ms="5" status="settled">done</event>'),
    ])
    const queued = events()
    expect(queued).toHaveLength(1)
    expect(queued[0]!.value).toMatch(
      /^<event nonce="[\w-]+" kind="repl-eval" at="[^"]+" eval="2" status="lost">eval #2 never settled: the process that was running it exited\. Its result is lost and the script is no longer running; a command it had started may have run on\.<\/event>$/,
    )
    expect(pollEventWakes(queued[0]!.pollEvent!)).toBe(true)
    expect(rows.map(row => row.type)).toEqual(['assistant', 'user'])
    expect(rows.every(row => (row as { isVirtual?: boolean }).isVirtual)).toBe(true)
    expect(JSON.stringify(rows[1])).toContain('"content":"Lost: Claude Code exited before this finished","is_error":true')
  })

  test('the interactive caller queues it without starting a turn', async () => {
    noteReplLaunchPermissionMode('bypassPermissions')
    await reportLostReplEvals([use('t1', 'REPL'), earlier(result('t1', '(dispatched #1)'))], { startsTurn: false })
    const queued = events()
    expect(queued).toHaveLength(1)
    expect(queued[0]!.pollEvent!.startsTurn).toBe(false)
    expect(pollEventWakes(queued[0]!.pollEvent!)).toBe(false)
  })

  test('receipts from this process, or no event delivery, queue nothing', async () => {
    noteReplLaunchPermissionMode('bypassPermissions')
    expect(await reportLostReplEvals([use('t1', 'REPL'), result('t1', '(dispatched #1)')])).toEqual([])
    expect(events()).toHaveLength(0)
    resetCodeModeGateForTesting()
    noteReplLaunchPermissionMode('default')
    expect(await reportLostReplEvals([use('t1', 'REPL'), earlier(result('t1', '(dispatched #1)'))])).toEqual([])
    expect(events()).toHaveLength(0)
  })
})
