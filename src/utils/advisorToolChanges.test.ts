import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  MID_CONVERSATION_SYSTEM_BETA_HEADER as SYSTEM_BETA,
  MID_CONVERSATION_TOOL_CHANGES_BETA_HEADER as TOOL_CHANGES_BETA,
} from '../constants/betas.js'
import {
  applyToolChangeBetas,
  modelSupportsToolChanges,
  recordSystemTurnRejection,
  recordToolChangeRejection,
  resetToolChangeLatchesForTesting,
  shouldOfferToolChangeBetas,
  type ToolChangeSticky,
  toolChangesRide,
} from './advisorToolChanges.js'

const ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
  'CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM',
  'ANTHROPIC_BASE_URL',
]
const saved: Record<string, string | undefined> = {}
const MODEL = 'claude-sonnet-5-5'

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL = '1'
})
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  resetToolChangeLatchesForTesting()
})

describe('modelSupportsToolChanges', () => {
  test('models with system turns and the catalog flag', () => {
    expect(modelSupportsToolChanges(MODEL)).toBe(true)
    expect(modelSupportsToolChanges('claude-opus-5')).toBe(true)
    expect(modelSupportsToolChanges('claude-sonnet-5')).toBe(false)
    expect(modelSupportsToolChanges('claude-sonnet-4-6')).toBe(false)
  })

  test('the force env, other providers and the experimental-betas switch', () => {
    process.env.CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM = '1'
    expect(modelSupportsToolChanges('claude-sonnet-4-6')).toBe(true)
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    expect(modelSupportsToolChanges(MODEL)).toBe(false)
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(modelSupportsToolChanges(MODEL)).toBe(false)
  })

  test('the betas are offered only while the advisor is on', () => {
    delete process.env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL
    expect(shouldOfferToolChangeBetas(MODEL)).toBe(false)
    expect(toolChangesRide({}, MODEL)).toBe(false)
    process.env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL = '1'
    expect(shouldOfferToolChangeBetas(MODEL)).toBe(true)
    process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1'
    expect(shouldOfferToolChangeBetas(MODEL)).toBe(false)
    expect(toolChangesRide({}, MODEL)).toBe(false)
  })
})

describe('applyToolChangeBetas', () => {
  const offered = () => ['other', TOOL_CHANGES_BETA, SYSTEM_BETA]

  test('a conversation keeps both betas once sent', () => {
    const sticky: ToolChangeSticky = {}
    const first = offered()
    applyToolChangeBetas(sticky, first, MODEL)
    expect(first).toEqual(offered())
    expect(sticky.sent).toBe(true)
    const later = ['other']
    applyToolChangeBetas(sticky, later, MODEL)
    expect(later).toEqual(['other', TOOL_CHANGES_BETA, SYSTEM_BETA])
  })

  test('requests without conversation state drop them', () => {
    const betas = offered()
    applyToolChangeBetas(undefined, betas, MODEL)
    expect(betas).toEqual(['other'])
  })

  test('a header rejection drops them for the conversation and the host', () => {
    const sticky: ToolChangeSticky = {}
    applyToolChangeBetas(sticky, offered(), MODEL)
    recordToolChangeRejection(sticky, 'header_rejected', MODEL)
    expect(sticky).toEqual({ rejected: true })
    const betas = offered()
    applyToolChangeBetas(sticky, betas, MODEL)
    expect(betas).toEqual(['other'])
    expect(toolChangesRide(sticky, MODEL)).toBe(false)
    // The host latch keeps a new conversation off too.
    expect(toolChangesRide({}, MODEL)).toBe(false)
    expect(shouldOfferToolChangeBetas(MODEL)).toBe(false)
  })

  test('a model rejection latches only that model', () => {
    recordToolChangeRejection({}, 'model_unsupported', MODEL)
    expect(modelSupportsToolChanges(MODEL)).toBe(false)
    expect(modelSupportsToolChanges('claude-opus-5')).toBe(true)
  })

  test('a system-turn rejection keeps the conversation off', () => {
    const sticky: ToolChangeSticky = {}
    applyToolChangeBetas(sticky, offered(), MODEL)
    recordSystemTurnRejection(sticky)
    expect(sticky).toEqual({ rejected: true, systemRejected: true })
    const betas = offered()
    applyToolChangeBetas(sticky, betas, MODEL)
    expect(betas).toEqual(['other'])
    expect(toolChangesRide({}, MODEL)).toBe(true)
  })
})
