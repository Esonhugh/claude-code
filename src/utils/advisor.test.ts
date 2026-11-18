import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import * as growthbook from '../services/analytics/growthbook.js'

let allowedModels: ((model: string) => boolean) | undefined
mock.module('./model/modelAllowlist.js', () => ({
  isModelAllowed: (model: string) => allowedModels?.(model) ?? true,
}))

const {
  getAdvisorAliasOptions,
  getAdvisorAnnouncementText,
  getAdvisorErrorCode,
  getAdvisorRank,
  getAdvisorRefusalText,
  getLastAdvisorAttachment,
  hasFullAdvisorAnnouncement,
  isAdvisorEnabled,
  getAdvisorRankKey,
  isAdvisorPairingAllowed,
  isAdvisorPairingAllowedStrict,
  isAdvisorRefusal,
  isAdvisorToolAllowed,
  isValidAdvisorModel,
  modelSupportsAdvisor,
  recordAdvisorRefusal,
  resetAdvisorRefusalsForTesting,
  resolveAdvisorModel,
  ADVISOR_TOOL_INSTRUCTIONS,
  ADVISOR_TOOL_NAME,
  LOCAL_ADVISOR_TOOL_PROMPT,
  getLocalAdvisorModel,
  isLocalAdvisorEnabled,
  omitUnsetLocalAdvisorTool,
} = await import('./advisor.js')

const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
  'CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL',
  'CLAUDE_CODE_ENABLE_LOCAL_ADVISOR_TOOL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
] as const
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  allowedModels = undefined
  resetAdvisorRefusalsForTesting()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  resetAdvisorRefusalsForTesting()
})

describe('advisor mount matrix', () => {
  test('only firstParty mounts the advisor', () => {
    expect(isAdvisorToolAllowed()).toBe(true)
    expect(isAdvisorEnabled()).toBe(true)
    for (const key of [
      'CLAUDE_CODE_USE_OPENAI',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ] as const) {
      process.env[key] = '1'
      expect(isAdvisorToolAllowed()).toBe(false)
      expect(isAdvisorEnabled()).toBe(false)
      delete process.env[key]
    }
  })

  test('a custom ANTHROPIC_BASE_URL is still firstParty', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.test'
    expect(isAdvisorEnabled()).toBe(true)
  })

  test('env switches', () => {
    process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1'
    process.env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL = '1'
    expect(isAdvisorToolAllowed()).toBe(false)
    expect(isAdvisorEnabled()).toBe(false)
    delete process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL

    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    expect(isAdvisorEnabled()).toBe(false)
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS

    expect(isAdvisorEnabled()).toBe(true)
  })

  test('GrowthBook cannot turn the advisor off', () => {
    // Telemetry on: GrowthBook may answer. A missing flag and an explicit
    // false both leave the advisor on.
    process.env.CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY = '1'
    const remote = spyOn(growthbook, 'getFeatureValue_CACHED_MAY_BE_STALE')
    try {
      remote.mockImplementation(((key: string, fallback: unknown) =>
        key === 'tengu_sage_compass2' ? { enabled: false } : fallback) as never)
      expect(isAdvisorEnabled()).toBe(true)
      remote.mockImplementation(((_key: string, fallback: unknown) => fallback) as never)
      expect(isAdvisorEnabled()).toBe(true)
    } finally {
      remote.mockRestore()
    }
  })

  test('process and host refusals switch the tool off', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://a.example.test'
    recordAdvisorRefusal('host')
    expect(isAdvisorToolAllowed()).toBe(false)
    process.env.ANTHROPIC_BASE_URL = 'https://b.example.test'
    expect(isAdvisorToolAllowed()).toBe(true)
    recordAdvisorRefusal('process')
    expect(isAdvisorToolAllowed()).toBe(false)
  })
})

describe('advisor ranks', () => {
  test('official rank table', () => {
    const table: [string, number | undefined][] = [
      ['claude-haiku-4-5-20251001', 1],
      ['claude-sonnet-4-6', 2],
      ['claude-opus-4-6', 3],
      ['claude-haiku-5-5', 4],
      ['claude-sonnet-5', 4],
      ['claude-opus-4-7', 5],
      ['claude-opus-4-8', 5],
      ['claude-sonnet-5-5', 6],
      ['claude-opus-5', 7],
      ['claude-opus-5-5', 7],
      ['claude-fable-5', 8],
      ['claude-mythos-5', 8],
      ['claude-fable-5-1', 9],
      ['claude-mythos-5-1', 9],
      ['claude-fable-5-2', 10],
      ['claude-mythos-5-2', 10],
      ['claude-opus-4-6[1m]', 3],
      ['claude-3-5-haiku-20241022', undefined],
      ['claude-3-7-sonnet-20250219', undefined],
      ['claude-sonnet-4-5-20250929', undefined],
      ['claude-opus-4-1-20250805', undefined],
      ['claude-opus-4-5-20251101', undefined],
      ['gpt-5', undefined],
      // Unknown minor versions are not their family's known model.
      ['claude-fable-5-3', undefined],
      ['claude-opus-5-1', undefined],
      ['claude-sonnet-5-12', undefined],
      ['claude-opus-5-20270101', 7],
      ['claude-opus-5-20270101[1m]', 7],
      ['claude-opus-5-2027010', undefined],
    ]
    for (const [model, rank] of table) {
      expect([model, getAdvisorRank(model)]).toEqual([model, rank])
    }
  })

  test('haiku can call the advisor but cannot be one', () => {
    expect(modelSupportsAdvisor('claude-haiku-4-5')).toBe(true)
    expect(isValidAdvisorModel('claude-haiku-4-5')).toBe(false)
    expect(isValidAdvisorModel('claude-sonnet-4-6')).toBe(true)
    expect(modelSupportsAdvisor('claude-opus-4-5')).toBe(false)
  })

  test('pairing requires an advisor at least as capable', () => {
    expect(isAdvisorPairingAllowed('claude-sonnet-4-6', 'claude-opus-4-6')).toBe(true)
    expect(isAdvisorPairingAllowed('claude-opus-4-6', 'claude-opus-4-6')).toBe(true)
    expect(isAdvisorPairingAllowed('claude-fable-5-1', 'claude-opus-5')).toBe(false)
    expect(isAdvisorPairingAllowed('claude-opus-4-5', 'claude-sonnet-4-6')).toBe(true)
  })

  test('the standby pairing also needs both ranks known', () => {
    expect(isAdvisorPairingAllowedStrict('claude-sonnet-5-5', 'claude-opus-5')).toBe(true)
    expect(isAdvisorPairingAllowedStrict('claude-fable-5-1', 'claude-opus-5')).toBe(false)
    expect(isAdvisorPairingAllowedStrict('claude-opus-4-5', 'claude-sonnet-4-6')).toBe(false)
    expect(getAdvisorRankKey('claude-sonnet-5-5[1m]')).toBe('sonnet-5-5')
    expect(getAdvisorRankKey('claude-opus-4-5')).toBeUndefined()
  })

  test('the experimental env skips every rank check', () => {
    process.env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL = '1'
    expect(modelSupportsAdvisor('claude-opus-4-5')).toBe(true)
    expect(isValidAdvisorModel('claude-haiku-4-5')).toBe(true)
    expect(isAdvisorPairingAllowed('claude-fable-5-1', 'claude-sonnet-4-6')).toBe(true)
  })

  test('availableModels excludes advisors and aliases', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-5'
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'claude-fable-5-1'
    expect(getAdvisorAliasOptions()).toEqual(['fable', 'opus', 'sonnet'])
    allowedModels = model => !model.includes('fable')
    expect(isValidAdvisorModel('claude-fable-5-1')).toBe(false)
    expect(getAdvisorAliasOptions()).toEqual(['opus', 'sonnet'])
  })

  test('resolveAdvisorModel resolves aliases and skips bad pairings', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5'
    expect(resolveAdvisorModel('opus', 'claude-sonnet-5')).toBe('claude-opus-5')
    expect(resolveAdvisorModel('opus', 'claude-fable-5-1')).toBeUndefined()
    expect(resolveAdvisorModel('claude-haiku-4-5', 'claude-haiku-4-5')).toBeUndefined()
    expect(resolveAdvisorModel(undefined, 'claude-sonnet-5')).toBeUndefined()
    process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1'
    expect(resolveAdvisorModel('opus', 'claude-sonnet-5')).toBeUndefined()
  })
})

describe('advisor blocks and attachments', () => {
  const result = (content: object) => ({
    type: 'advisor_tool_result',
    tool_use_id: 'srvtoolu_1',
    content,
  })

  test('error codes outside the known list read unknown', () => {
    expect(getAdvisorErrorCode(result({ type: 'advisor_tool_result_error', error_code: 'overloaded' }))).toBe('overloaded')
    expect(getAdvisorErrorCode(result({ type: 'advisor_tool_result_error', error_code: 'model_not_found' }))).toBe('unknown')
    expect(getAdvisorErrorCode(result({ type: 'advisor_tool_result_error' }))).toBe('unknown')
    expect(getAdvisorErrorCode(result({ type: 'advisor_result', text: 'x' }))).toBeUndefined()
  })

  test('refusal is stop_reason refusal on a result', () => {
    const refused = result({ type: 'advisor_result', text: 'no', stop_reason: 'refusal' })
    expect(isAdvisorRefusal(refused)).toBe(true)
    expect(getAdvisorRefusalText(refused)).toBe('no')
    expect(isAdvisorRefusal(result({ type: 'advisor_redacted_result', encrypted_content: 'e', stop_reason: 'refusal' }))).toBe(true)
    expect(isAdvisorRefusal(result({ type: 'advisor_result', text: 'ok', stop_reason: 'end_turn' }))).toBe(false)
  })

  test('announcement text variants', () => {
    expect(getAdvisorAnnouncementText({ type: 'advisor_tool', available: true, model: 'm' })).toBe(ADVISOR_TOOL_INSTRUCTIONS)
    expect(ADVISOR_TOOL_INSTRUCTIONS).toStartWith('# Advisor Tool\n\nYou have access to an `advisor` tool')
    expect(getAdvisorAnnouncementText({ type: 'advisor_tool', available: true, model: 'm', abbreviated: true })).toBe(
      'The advisor tool is available; the advisor instructions announced earlier apply.',
    )
    expect(getAdvisorAnnouncementText({ type: 'advisor_tool', available: false })).toBe(
      'The advisor tool is no longer available; disregard the earlier advisor instructions.',
    )
  })

  test('last attachment and full announcement lookup', () => {
    const attach = (attachment: object) =>
      ({ type: 'attachment', uuid: 'u', timestamp: 't', attachment }) as never
    const messages = [
      attach({ type: 'advisor_tool', available: true, model: 'a', abbreviated: true }),
      attach({ type: 'ultrathink_effort', level: 'high' }),
    ]
    expect(getLastAdvisorAttachment(messages)).toEqual({ type: 'advisor_tool', available: true, model: 'a', abbreviated: true })
    expect(hasFullAdvisorAnnouncement(messages)).toBe(false)
    messages.push(attach({ type: 'advisor_tool', available: true, model: 'a' }))
    expect(hasFullAdvisorAnnouncement(messages)).toBe(true)
  })
})

describe('local advisor', () => {
  const tools = [{ name: 'Bash' }, { name: ADVISOR_TOOL_NAME }]

  test('is off by default and leaves the server-side advisor as it was', () => {
    expect(isLocalAdvisorEnabled()).toBe(false)
    expect(isAdvisorToolAllowed()).toBe(true)
    expect(getLocalAdvisorModel('opus')).toBeUndefined()
    expect(isValidAdvisorModel('Opus 5.5')).toBe(false)
    expect(omitUnsetLocalAdvisorTool(tools, undefined)).toBe(tools)
  })

  test('the switch replaces the server-side advisor on any provider', () => {
    process.env.CLAUDE_CODE_ENABLE_LOCAL_ADVISOR_TOOL = '1'
    expect(isLocalAdvisorEnabled()).toBe(true)
    expect(isAdvisorToolAllowed()).toBe(false)
    expect(isAdvisorEnabled()).toBe(true)
    expect(resolveAdvisorModel('opus', 'claude-sonnet-5')).toBeUndefined()
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(isAdvisorEnabled()).toBe(true)
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    expect(isAdvisorEnabled()).toBe(true)
  })

  test('CLAUDE_CODE_DISABLE_ADVISOR_TOOL wins over the switch', () => {
    process.env.CLAUDE_CODE_ENABLE_LOCAL_ADVISOR_TOOL = '1'
    process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1'
    expect(isLocalAdvisorEnabled()).toBe(false)
    expect(isAdvisorEnabled()).toBe(false)
    expect(getLocalAdvisorModel('opus')).toBeUndefined()
  })

  test('any allowed model can advise any main model', () => {
    process.env.CLAUDE_CODE_ENABLE_LOCAL_ADVISOR_TOOL = '1'
    expect(modelSupportsAdvisor('Grok-4.7')).toBe(true)
    expect(isValidAdvisorModel('Opus 5.5')).toBe(true)
    expect(isAdvisorPairingAllowed('claude-fable-5-1', 'claude-haiku-4-5')).toBe(true)
    expect(getLocalAdvisorModel('Opus 5.5')).toBe('Opus 5.5')
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'gateway-opus'
    expect(getLocalAdvisorModel('opus')).toBe('gateway-opus')
    expect(getLocalAdvisorModel(undefined)).toBeUndefined()
    allowedModels = model => model !== 'Opus 5.5'
    expect(getLocalAdvisorModel('Opus 5.5')).toBeUndefined()
  })

  test('a request offers the tool only while an advisor model is set', () => {
    process.env.CLAUDE_CODE_ENABLE_LOCAL_ADVISOR_TOOL = '1'
    expect(omitUnsetLocalAdvisorTool(tools, 'Opus 5.5')).toBe(tools)
    expect(omitUnsetLocalAdvisorTool(tools, undefined)).toEqual([{ name: 'Bash' }])
  })

  test('the tool prompt keeps the official guidance without the stronger-model claim', () => {
    const guidance = ADVISOR_TOOL_INSTRUCTIONS.slice(
      ADVISOR_TOOL_INSTRUCTIONS.indexOf('Call advisor BEFORE substantive work'),
    )
    expect(guidance.length).toBeGreaterThan(1000)
    expect(LOCAL_ADVISOR_TOOL_PROMPT.endsWith(guidance)).toBe(true)
    expect(LOCAL_ADVISOR_TOOL_PROMPT).toContain('takes NO parameters')
    expect(LOCAL_ADVISOR_TOOL_PROMPT).not.toContain('stronger')
  })
})
