import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { clearBetaHeaderLatches } from '../bootstrap/state.js'
import type { Message } from '../types/message.js'
import type { AdvisorToolAttachment } from './advisor.js'
import { recordAdvisorRefusal, resetAdvisorRefusalsForTesting } from './advisor.js'
import {
  type AdvisorCarrier,
  describeHeldAdvisor,
  getAdvisorQueryKind,
  getMainAdvisorCarrier,
  resetMainAdvisorCarrier,
  resolveAdvisorForQuery,
  toAdvisorRequest,
} from './advisorQuery.js'

const SWITCH = 'CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL'
const ENV_KEYS = [
  'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
  SWITCH,
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_USE_BEDROCK',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env[SWITCH] = '1'
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

const NO_ENTRY = {
  announcement: undefined,
  advisorModel: undefined,
  advisorDeferred: false,
  advisorActive: false,
}

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
      advisorDeferred: false,
      advisorActive: true,
    })
    expect(run(messages, carrier)).toEqual({
      announcement: undefined,
      advisorModel: 'claude-opus-5',
      advisorDeferred: false,
      advisorActive: true,
    })
  })

  test('the held advisor ignores setting changes until the carrier resets', () => {
    const messages: Message[] = []
    const carrier: AdvisorCarrier = {}
    run(messages, carrier, { setting: undefined })
    expect(carrier.held).toEqual({ model: undefined, viaToolChange: false })
    expect(run(messages, carrier).advisorModel).toBeUndefined()

    const other: AdvisorCarrier = {}
    run([], other)
    expect(run([], other, { setting: 'sonnet' }).advisorModel).toBe('claude-opus-5')
  })

  test('withdraws when requests can no longer carry it, and comes back abbreviated', () => {
    const messages: Message[] = []
    const carrier: AdvisorCarrier = {}
    run(messages, carrier)
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    expect(run(messages, carrier)).toEqual({
      announcement: { type: 'advisor_tool', available: false, model: 'claude-opus-5', byBase: true },
      advisorModel: undefined,
      advisorDeferred: false,
      advisorActive: false,
    })
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
    expect(run(messages, carrier)).toEqual({
      announcement: { type: 'advisor_tool', available: true, model: 'claude-opus-5', abbreviated: true },
      advisorModel: 'claude-opus-5',
      advisorDeferred: false,
      advisorActive: true,
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
      advisorDeferred: false,
      advisorActive: false,
    })
    expect(run(messages, carrier)).toEqual(NO_ENTRY)
    // Resumed later: the transcript keeps it off.
    expect(run(messages, {})).toEqual(NO_ENTRY)
  })

  test('restores the held advisor from the transcript', () => {
    const messages = [attach({ type: 'advisor_tool', available: true, model: 'claude-opus-5' })]
    expect(run(messages, {}, { setting: 'sonnet' })).toEqual({
      announcement: undefined,
      advisorModel: 'claude-opus-5',
      advisorDeferred: false,
      advisorActive: true,
    })
  })

  test('any main or subagent model carries the advisor the setting names', () => {
    const args = {
      querySource: 'agent:custom' as never,
      configuredModel: 'claude-fable-5-1',
    }
    expect(run([], {}, { ...args, requestModel: 'claude-sonnet-5' }).advisorModel).toBe('claude-opus-5')
    expect(run([], {}, { ...args, requestModel: 'claude-fable-5-1' }).advisorModel).toBe('claude-opus-5')
    expect(run([], {}, { configuredModel: 'claude-fable-5-1', requestModel: 'claude-sonnet-5' }).advisorModel).toBe('claude-opus-5')
    const gateway = { configuredModel: 'Grok-4.7', requestModel: 'Grok-4.7' }
    expect(run([], {}, gateway).advisorModel).toBe('claude-opus-5')
    expect(run([], {}, { ...gateway, setting: 'Opus 5.5' }).advisorModel).toBe('Opus 5.5')
    expect(run([], {}, { setting: 'claude-haiku-4-5' }).advisorModel).toBe('claude-haiku-4-5')
  })

  test('auxiliary requests follow the held advisor without announcing or pinning', () => {
    const carrier: AdvisorCarrier = {}
    expect(run([], carrier, { querySource: 'compact' })).toEqual({
      announcement: undefined,
      advisorModel: 'claude-opus-5',
      advisorDeferred: false,
      advisorActive: true,
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
    expect(run([], {})).toEqual(NO_ENTRY)
  })

  test('without the switch no request carries the advisor', () => {
    delete process.env[SWITCH]
    const carrier: AdvisorCarrier = {}
    expect(run([], carrier)).toEqual(NO_ENTRY)
    expect(run([], {}, { toolChangesRide: true })).toEqual(NO_ENTRY)
    expect(toAdvisorRequest(run([], carrier), carrier, 'opus').localAdvisorModel).toBeUndefined()
  })
})

describe('describeHeldAdvisor', () => {
  test('explains what the current conversation keeps', () => {
    expect(describeHeldAdvisor([], 'claude-sonnet-5', 'claude-sonnet-5')).toBe('')
    getMainAdvisorCarrier().held = { model: 'claude-opus-5' }
    expect(describeHeldAdvisor([], 'claude-opus-5', 'claude-sonnet-5')).toBe('')
    expect(describeHeldAdvisor([], 'claude-sonnet-5', 'claude-sonnet-5')).toBe(
      '\nThe current conversation keeps Opus 5 as its advisor until /clear or /compact, so the prompt it has already sent stays unchanged; the new setting applies from there and in new conversations.',
    )
    // A conversation that sends no server-side advisor has nothing to keep:
    // the local advisor answers it and reads the setting on every call.
    getMainAdvisorCarrier().held = { model: undefined }
    expect(describeHeldAdvisor([], 'claude-sonnet-5', 'claude-sonnet-5')).toBe('')
    getMainAdvisorCarrier().held = { model: undefined, refused: true }
    expect(describeHeldAdvisor([], undefined, 'claude-sonnet-5')).toBe('')
    expect(describeHeldAdvisor([], 'claude-sonnet-5', 'claude-sonnet-5')).toBe('')
    getMainAdvisorCarrier().held = { model: 'claude-opus-5' }
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    expect(describeHeldAdvisor([], 'claude-sonnet-5', 'claude-sonnet-5')).toBe('')
  })

  test('an entry removed for good leaves the conversation to the local advisor', () => {
    getMainAdvisorCarrier().held = { model: 'claude-opus-5' }
    const removed = [
      attach({ type: 'advisor_tool', available: false, model: 'claude-opus-5', toolChange: 'remove' }),
    ]
    expect(describeHeldAdvisor(removed, 'claude-sonnet-5', 'claude-sonnet-5')).toBe('')
  })
})

describe('resolveAdvisorForQuery with the tool-change beta', () => {
  const MAIN = 'claude-sonnet-5-5'
  const ride = (overrides: Partial<Parameters<typeof resolveAdvisorForQuery>[1]> = {}) => ({
    configuredModel: MAIN,
    requestModel: MAIN,
    toolChangesRide: true,
    ...overrides,
  })

  test('/advisor on and off become tool_addition and tool_removal on one deferred entry', () => {
    const messages: Message[] = []
    const carrier: AdvisorCarrier = {}
    expect(run(messages, carrier, ride())).toEqual({
      announcement: { type: 'advisor_tool', available: true, model: 'claude-opus-5', toolChange: 'add' },
      advisorModel: 'claude-opus-5',
      advisorDeferred: true,
      advisorActive: true,
    })
    expect(run(messages, carrier, ride()).announcement).toBeUndefined()
    expect(run(messages, carrier, ride({ setting: undefined }))).toEqual({
      announcement: { type: 'advisor_tool', available: false, model: 'claude-opus-5', toolChange: 'remove' },
      advisorModel: 'claude-opus-5',
      advisorDeferred: true,
      advisorActive: false,
    })
    expect(run(messages, carrier, ride())).toEqual({
      announcement: {
        type: 'advisor_tool', available: true, model: 'claude-opus-5', abbreviated: true, toolChange: 'add',
      },
      advisorModel: 'claude-opus-5',
      advisorDeferred: true,
      advisorActive: true,
    })
    // Another advisor model only applies after /clear or /compact.
    expect(run(messages, carrier, ride({ setting: 'fable' })).advisorModel).toBe('claude-opus-5')
  })

  test('a conversation that began without an advisor declares it when /advisor turns it on', () => {
    const messages: Message[] = []
    const carrier: AdvisorCarrier = {}
    expect(run(messages, carrier, ride({ setting: undefined }))).toEqual(NO_ENTRY)
    expect(carrier.held).toEqual({ model: undefined, viaToolChange: true })
    expect(run(messages, carrier, ride())).toMatchObject({
      announcement: { available: true, model: 'claude-opus-5', toolChange: 'add' },
      advisorDeferred: true,
      advisorActive: true,
    })
  })

  test('when the beta stops riding the entry is declared inline from then on', () => {
    const messages: Message[] = []
    const carrier: AdvisorCarrier = {}
    run(messages, carrier, ride())
    expect(run(messages, carrier, ride({ toolChangesRide: false }))).toEqual({
      announcement: undefined,
      advisorModel: 'claude-opus-5',
      advisorDeferred: false,
      advisorActive: true,
    })
    expect(carrier.held).toMatchObject({ viaToolChange: true, inFallback: true })
    // Back on the existing path: the inline entry stays until /clear or /compact.
    expect(run(messages, carrier, ride({ toolChangesRide: false, setting: undefined }))).toMatchObject({
      advisorModel: 'claude-opus-5',
      advisorDeferred: false,
    })
  })

  test('describeHeldAdvisor says on/off applies right away', () => {
    getMainAdvisorCarrier().held = { model: 'claude-opus-5', viaToolChange: true }
    expect(describeHeldAdvisor([], 'claude-opus-5', MAIN)).toBe('')
    expect(describeHeldAdvisor([], undefined, MAIN)).toBe('')
    expect(describeHeldAdvisor([], 'fable', MAIN)).toBe(
      '\nThe current conversation keeps Opus 5 as its advisor model until /clear or /compact, so the tool it has already declared stays unchanged; turning the advisor on or off applies right away.',
    )
  })
})

describe('local advisor as the fallback', () => {
  const local = (
    carrier: AdvisorCarrier,
    setting: string | undefined,
    overrides: Partial<Parameters<typeof resolveAdvisorForQuery>[1]> = {},
  ) =>
    toAdvisorRequest(run([], carrier, { setting, ...overrides }), carrier, setting)
      .localAdvisorModel

  test('a request that carries the server-side advisor does not offer the local one', () => {
    const carrier: AdvisorCarrier = {}
    const result = run([], carrier, { setting: 'Opus 5.5', configuredModel: 'Grok-4.7', requestModel: 'Grok-4.7' })
    expect(result.advisorModel).toBe('Opus 5.5')
    expect(toAdvisorRequest(result, carrier, 'Opus 5.5').localAdvisorModel).toBeUndefined()
  })

  test('a request the server-side advisor cannot serve goes to the local one', () => {
    // The API refused the advisor for this conversation.
    expect(local({ held: { model: undefined, refused: true } }, 'opus')).toBe('claude-opus-5')
    // The conversation began without an advisor and keeps none.
    expect(local({ held: { model: undefined } }, 'opus')).toBe('claude-opus-5')
    // No advisor is set.
    expect(local({}, undefined)).toBeUndefined()
    // The endpoint refused the advisor for this host.
    recordAdvisorRefusal('host')
    expect(local({}, 'Opus 5.5')).toBe('Opus 5.5')
    resetAdvisorRefusalsForTesting()
    // The endpoint takes no experimental betas.
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    expect(local({}, 'opus')).toBe('claude-opus-5')
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
    // The provider is not the Anthropic API.
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(run([], {})).toEqual(NO_ENTRY)
    expect(local({}, 'opus')).toBeDefined()
  })

  test('/advisor still says which server-side advisor the conversation keeps', () => {
    getMainAdvisorCarrier().held = { model: 'claude-opus-5' }
    expect(describeHeldAdvisor([], 'Opus 5.5', 'Grok-4.7')).toContain(
      'The current conversation keeps Opus 5 as its advisor until /clear or /compact',
    )
  })
})
