import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { clearBetaHeaderLatches } from '../bootstrap/state.js'
import type { Message } from '../types/message.js'
import type { AdvisorToolAttachment } from './advisor.js'
import { resetAdvisorRefusalsForTesting } from './advisor.js'
import {
  type AdvisorCarrier,
  describeHeldAdvisor,
  getAdvisorQueryKind,
  getMainAdvisorCarrier,
  resetMainAdvisorCarrier,
  resolveAdvisorForQuery,
} from './advisorQuery.js'

const ENV_KEYS = [
  'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
  'CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5'
  resetAdvisorRefusalsForTesting()
  resetMainAdvisorCarrier()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const attach = (attachment: AdvisorToolAttachment): Message =>
  ({ type: 'attachment', uuid: 'u', timestamp: 't', attachment }) as unknown as Message

function run(
  messages: Message[],
  carrier: AdvisorCarrier,
  overrides: Partial<Parameters<typeof resolveAdvisorForQuery>[1]> = {},
) {
  const result = resolveAdvisorForQuery(messages, {
    querySource: 'repl_main_thread',
    setting: 'opus',
    configuredModel: 'claude-sonnet-5',
    requestModel: 'claude-sonnet-5',
    carrier,
    ...overrides,
  })
  if (result.announcement) messages.push(attach(result.announcement))
  return result
}

describe('resolveAdvisorForQuery', () => {
  test('query source kinds', () => {
    expect(getAdvisorQueryKind('repl_main_thread')).toBe('main')
    expect(getAdvisorQueryKind('repl_main_thread:outputStyle:x' as never)).toBe('main')
    expect(getAdvisorQueryKind('sdk')).toBe('main')
    expect(getAdvisorQueryKind('agent:custom' as never)).toBe('subagent')
    expect(getAdvisorQueryKind('hook_agent')).toBe('subagent')
    expect(getAdvisorQueryKind('compact')).toBe('auxiliary')
  })

  test('announces once in full, then rides without repeating', () => {
    const messages: Message[] = []
    const carrier: AdvisorCarrier = {}
    expect(run(messages, carrier)).toEqual({
      announcement: { type: 'advisor_tool', available: true, model: 'claude-opus-5' },
      advisorModel: 'claude-opus-5',
    })
    expect(run(messages, carrier)).toEqual({
      announcement: undefined,
      advisorModel: 'claude-opus-5',
    })
  })

  test('the held advisor ignores setting changes until the carrier resets', () => {
    const messages: Message[] = []
    const carrier: AdvisorCarrier = {}
    run(messages, carrier, { setting: undefined })
    expect(carrier.held).toEqual({ model: undefined })
    expect(run(messages, carrier).advisorModel).toBeUndefined()

    const other: AdvisorCarrier = {}
    run([], other)
    expect(run([], other, { setting: 'sonnet' }).advisorModel).toBe('claude-opus-5')
  })

  test('withdraws when the main model cannot use it, and comes back abbreviated', () => {
    const messages: Message[] = []
    const carrier: AdvisorCarrier = {}
    run(messages, carrier)
    expect(run(messages, carrier, { configuredModel: 'claude-opus-4-5', requestModel: 'claude-opus-4-5' })).toEqual({
      announcement: { type: 'advisor_tool', available: false, model: 'claude-opus-5', byBase: true },
      advisorModel: undefined,
    })
    expect(run(messages, carrier)).toEqual({
      announcement: { type: 'advisor_tool', available: true, model: 'claude-opus-5', abbreviated: true },
      advisorModel: 'claude-opus-5',
    })
  })

  test('a refused conversation announces the removal and stays off', () => {
    const messages: Message[] = []
    const carrier: AdvisorCarrier = {}
    run(messages, carrier)
    carrier.held = { model: undefined, refused: true }
    expect(run(messages, carrier)).toEqual({
      announcement: { type: 'advisor_tool', available: false },
      advisorModel: undefined,
    })
    expect(run(messages, carrier)).toEqual({ announcement: undefined, advisorModel: undefined })
    // Resumed later: the transcript keeps it off.
    expect(run(messages, {})).toEqual({ announcement: undefined, advisorModel: undefined })
  })

  test('restores the held advisor from the transcript', () => {
    const messages = [attach({ type: 'advisor_tool', available: true, model: 'claude-opus-5' })]
    expect(run(messages, {}, { setting: 'sonnet' })).toEqual({
      announcement: undefined,
      advisorModel: 'claude-opus-5',
    })
  })

  test('subagents pair against their own model', () => {
    const args = {
      querySource: 'agent:custom' as never,
      configuredModel: 'claude-fable-5-1',
    }
    expect(run([], {}, { ...args, requestModel: 'claude-sonnet-5' }).advisorModel).toBe('claude-opus-5')
    expect(run([], {}, { ...args, requestModel: 'claude-fable-5-1' }).advisorModel).toBeUndefined()
    expect(run([], {}, { configuredModel: 'claude-fable-5-1', requestModel: 'claude-sonnet-5' }).advisorModel).toBeUndefined()
  })

  test('auxiliary requests follow the held advisor without announcing or pinning', () => {
    const carrier: AdvisorCarrier = {}
    expect(run([], carrier, { querySource: 'compact' })).toEqual({
      announcement: undefined,
      advisorModel: 'claude-opus-5',
    })
    expect(carrier.held).toBeUndefined()
  })

  test('clearing the beta header latches (/clear, /compact) resets the main carrier', () => {
    getMainAdvisorCarrier().held = { model: undefined, refused: true }
    clearBetaHeaderLatches()
    expect(getMainAdvisorCarrier().held).toBeUndefined()
  })

  test('the disable env removes it', () => {
    process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1'
    expect(run([], {})).toEqual({ announcement: undefined, advisorModel: undefined })
  })
})

describe('describeHeldAdvisor', () => {
  test('explains what the current conversation keeps', () => {
    expect(describeHeldAdvisor([], 'claude-sonnet-5')).toBe('')
    getMainAdvisorCarrier().held = { model: 'claude-opus-5' }
    expect(describeHeldAdvisor([], 'claude-opus-5')).toBe('')
    expect(describeHeldAdvisor([], 'claude-sonnet-5')).toBe(
      '\nThe current conversation keeps Opus 5 as its advisor until /clear or /compact, so the prompt it has already sent stays unchanged; the new setting applies from there and in new conversations.',
    )
    getMainAdvisorCarrier().held = { model: undefined }
    expect(describeHeldAdvisor([], 'claude-sonnet-5')).toBe(
      '\nThe current conversation runs without the advisor until /clear or /compact, so the prompt it has already sent stays unchanged; the new setting applies from there and in new conversations.',
    )
    getMainAdvisorCarrier().held = { model: undefined, refused: true }
    expect(describeHeldAdvisor([], undefined)).toBe('')
    expect(describeHeldAdvisor([], 'claude-sonnet-5')).toBe(
      '\nThe API refused the advisor for the current conversation, so it runs without one until /clear or /compact; the setting applies from there and in new conversations.',
    )
  })
})
