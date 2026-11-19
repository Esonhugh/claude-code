import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import * as growthbook from '../services/analytics/growthbook.js'

let allowedModels: ((model: string) => boolean) | undefined
mock.module('./model/modelAllowlist.js', () => ({
  isModelAllowed: (model: string) => allowedModels?.(model) ?? true,
}))

const {
  getAdvisorAnnouncementText,
  getAdvisorErrorCode,
  getAdvisorRefusalText,
  getLastAdvisorAttachment,
  hasFullAdvisorAnnouncement,
  isAdvisorEnabled,
  isAdvisorRefusal,
  isAdvisorToolAllowed,
  isValidAdvisorModel,
  recordAdvisorRefusal,
  resetAdvisorRefusalsForTesting,
  resolveAdvisorModel,
  ADVISOR_TOOL_INSTRUCTIONS,
  ADVISOR_TOOL_NAME,
  LOCAL_ADVISOR_TOOL_PROMPT,
  getLocalAdvisorModel,
  omitLocalAdvisorTool,
} = await import('./advisor.js')

const SWITCH = 'CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL'
const OTHER_PROVIDERS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

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
  test('without the switch there is no advisor, server-side or local', () => {
    expect(isAdvisorEnabled()).toBe(false)
    expect(isAdvisorToolAllowed()).toBe(false)
    expect(resolveAdvisorModel('opus')).toBeUndefined()
    expect(getLocalAdvisorModel('opus')).toBeUndefined()
    // The retired local switch turns nothing on.
    process.env.CLAUDE_CODE_ENABLE_LOCAL_ADVISOR_TOOL = '1'
    expect(isAdvisorEnabled()).toBe(false)
    expect(getLocalAdvisorModel('opus')).toBeUndefined()
  })

  test('with the switch only firstParty sends the server-side advisor', () => {
    process.env[SWITCH] = '1'
    expect(isAdvisorEnabled()).toBe(true)
    expect(isAdvisorToolAllowed()).toBe(true)
    for (const key of OTHER_PROVIDERS) {
      process.env[key] = '1'
      expect(isAdvisorToolAllowed()).toBe(false)
      // The local advisor stands in.
      expect(isAdvisorEnabled()).toBe(true)
      delete process.env[key]
    }
  })

  test('a custom ANTHROPIC_BASE_URL is still firstParty', () => {
    process.env[SWITCH] = '1'
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.test'
    expect(isAdvisorToolAllowed()).toBe(true)
  })

  test('env switches', () => {
    process.env[SWITCH] = '1'
    process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1'
    expect(isAdvisorToolAllowed()).toBe(false)
    expect(isAdvisorEnabled()).toBe(false)
    expect(getLocalAdvisorModel('opus')).toBeUndefined()
    delete process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL

    // Without the betas only the local advisor is left.
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    expect(isAdvisorToolAllowed()).toBe(false)
    expect(isAdvisorEnabled()).toBe(true)
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS

    expect(isAdvisorToolAllowed()).toBe(true)
  })

  test('GrowthBook cannot turn the advisor off', () => {
    // Telemetry on: GrowthBook may answer. A missing flag and an explicit
    // false both leave the advisor to the switch.
    process.env[SWITCH] = '1'
    process.env.CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY = '1'
    const remote = spyOn(growthbook, 'getFeatureValue_CACHED_MAY_BE_STALE')
    try {
      remote.mockImplementation(((key: string, fallback: unknown) =>
        key === 'tengu_sage_compass2' ? { enabled: false } : fallback) as never)
      expect(isAdvisorToolAllowed()).toBe(true)
      remote.mockImplementation(((_key: string, fallback: unknown) => fallback) as never)
      expect(isAdvisorToolAllowed()).toBe(true)
    } finally {
      remote.mockRestore()
    }
  })

  test('process and host refusals leave the local advisor', () => {
    process.env[SWITCH] = '1'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5'
    process.env.ANTHROPIC_BASE_URL = 'https://a.example.test'
    recordAdvisorRefusal('host')
    expect(isAdvisorToolAllowed()).toBe(false)
    expect(isAdvisorEnabled()).toBe(true)
    expect(resolveAdvisorModel('opus')).toBeUndefined()
    expect(getLocalAdvisorModel('opus')).toBe('claude-opus-5')
    process.env.ANTHROPIC_BASE_URL = 'https://b.example.test'
    expect(isAdvisorToolAllowed()).toBe(true)
    recordAdvisorRefusal('process')
    expect(isAdvisorToolAllowed()).toBe(false)
    expect(isAdvisorEnabled()).toBe(true)
  })
})

describe('advisor models', () => {
  test('any model can advise, whatever the main model', () => {
    process.env[SWITCH] = '1'
    for (const model of ['claude-haiku-4-5', 'claude-opus-4-5', 'Opus 5.5', 'Grok-4.7']) {
      expect([model, isValidAdvisorModel(model)]).toEqual([model, true])
      expect(resolveAdvisorModel(model)).toBe(model)
      expect(getLocalAdvisorModel(model)).toBe(model)
    }
  })

  test('availableModels still excludes advisors', () => {
    process.env[SWITCH] = '1'
    allowedModels = model => !model.includes('fable')
    expect(isValidAdvisorModel('claude-fable-5-1')).toBe(false)
    expect(resolveAdvisorModel('claude-fable-5-1')).toBeUndefined()
    expect(getLocalAdvisorModel('claude-fable-5-1')).toBeUndefined()
    expect(isValidAdvisorModel('claude-opus-5')).toBe(true)
  })

  test('resolveAdvisorModel resolves aliases', () => {
    process.env[SWITCH] = '1'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5'
    expect(resolveAdvisorModel('opus')).toBe('claude-opus-5')
    expect(resolveAdvisorModel(undefined)).toBeUndefined()
    process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1'
    expect(resolveAdvisorModel('opus')).toBeUndefined()
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

  test('asks the model the setting names', () => {
    process.env[SWITCH] = '1'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'gateway-opus'
    expect(getLocalAdvisorModel('opus')).toBe('gateway-opus')
    expect(getLocalAdvisorModel(undefined)).toBeUndefined()
  })

  test('a request offers the tool only when the local advisor answers it', () => {
    process.env[SWITCH] = '1'
    expect(omitLocalAdvisorTool(tools, 'Opus 5.5')).toBe(tools)
    expect(omitLocalAdvisorTool(tools, undefined)).toEqual([{ name: 'Bash' }])
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
