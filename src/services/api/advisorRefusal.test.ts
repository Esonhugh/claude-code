import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import {
  ADVISOR_BETA_HEADER,
  MID_CONVERSATION_SYSTEM_BETA_HEADER,
  MID_CONVERSATION_TOOL_CHANGES_BETA_HEADER,
} from '../../constants/betas.js'
import {
  classifyAdvisorRefusal,
  classifyToolChangeRejection,
  isAdvisorIncompatibleError,
  isSystemTurnRejection,
} from './advisorRefusal.js'

const apiError = (status: number, message: string) =>
  APIError.generate(
    status,
    { type: 'error', error: { type: 'invalid_request_error', message } },
    undefined,
    new Headers(),
  )

describe('classifyAdvisorRefusal', () => {
  const withBeta = [ADVISOR_BETA_HEADER]

  test('scopes', () => {
    expect(classifyAdvisorRefusal(apiError(400, 'the advisor tool is not available for this organization'), withBeta)).toEqual({ scope: 'process', betaHeader: false })
    expect(classifyAdvisorRefusal(apiError(400, 'the advisor tool is not available for this model'), withBeta)).toEqual({ scope: 'conversation', betaHeader: false })
    expect(classifyAdvisorRefusal(apiError(400, 'claude-haiku-4-5 cannot be used as an advisor'), withBeta)).toEqual({ scope: 'conversation', betaHeader: false })
    expect(classifyAdvisorRefusal(apiError(400, 'tools.3.model: Input should be a valid model'), withBeta)).toEqual({ scope: 'conversation', betaHeader: false })
    expect(classifyAdvisorRefusal(apiError(400, "tools.3: Input tag 'advisor_20260301' found using 'type' does not match any of the expected tags"), withBeta)).toEqual({ scope: 'host', betaHeader: false })
    expect(classifyAdvisorRefusal(apiError(422, "Input tag 'advisor_20260301' is not supported"), withBeta)).toEqual({ scope: 'host', betaHeader: false })
    expect(classifyAdvisorRefusal(apiError(400, `Unexpected value(s) \`${ADVISOR_BETA_HEADER}\` for the \`anthropic-beta\` header`), withBeta)).toEqual({ scope: 'host', betaHeader: true })
    expect(classifyAdvisorRefusal(apiError(400, `capability_rejected: beta_header:${ADVISOR_BETA_HEADER}`), withBeta)).toEqual({ scope: 'host', betaHeader: true })
  })

  test('the beta rejection only counts when the request sent the beta', () => {
    expect(classifyAdvisorRefusal(apiError(400, `Unexpected value(s) \`${ADVISOR_BETA_HEADER}\` for the \`anthropic-beta\` header`), [])).toEqual({ scope: 'host', betaHeader: false })
  })

  test('unrelated errors and incompatible pairings are not refusals', () => {
    expect(classifyAdvisorRefusal(apiError(400, 'prompt is too long'), withBeta)).toBeUndefined()
    expect(classifyAdvisorRefusal(apiError(422, 'the advisor tool is not available'), withBeta)).toBeUndefined()
    expect(classifyAdvisorRefusal(apiError(500, 'the advisor tool is not available'), withBeta)).toBeUndefined()
    expect(classifyAdvisorRefusal(new Error('the advisor tool is not available'), withBeta)).toBeUndefined()
    const incompatible = apiError(400, 'claude-sonnet-4-6 cannot be used as an advisor when the request model is claude-opus-5')
    expect(classifyAdvisorRefusal(incompatible, withBeta)).toBeUndefined()
    expect(isAdvisorIncompatibleError(incompatible)).toBe(true)
    expect(isAdvisorIncompatibleError(apiError(400, 'claude-haiku-4-5 cannot be used as an advisor'))).toBe(false)
  })
})

const codedError = (status: number, code: string, message: string) =>
  APIError.generate(
    status,
    { type: 'error', error: { type: 'invalid_request_error', message, details: { error_code: code } } },
    undefined,
    new Headers(),
  )

describe('classifyToolChangeRejection', () => {
  test('kinds', () => {
    expect(classifyToolChangeRejection(codedError(400, 'mid_conversation_tool_changes_not_supported', 'x'))).toBe('model_unsupported')
    expect(classifyToolChangeRejection(apiError(400, "messages.3.content.1: Input tag 'tool_addition' found using 'type' does not match any of the expected tags"))).toBe('block_type_unknown')
    expect(classifyToolChangeRejection(apiError(400, `Unexpected value(s) \`${MID_CONVERSATION_TOOL_CHANGES_BETA_HEADER}\` for the \`anthropic-beta\` header`))).toBe('header_rejected')
    expect(classifyToolChangeRejection(apiError(400, 'tool_addition is not supported on this model'))).toBe('model_unsupported')
    expect(classifyToolChangeRejection(apiError(400, 'tool_addition cannot follow a paused assistant turn'))).toBe('after_paused_turn')
    expect(classifyToolChangeRejection(apiError(400, 'tool_addition references an undeclared tool'))).toBe('unknown_tool_reference')
    expect(classifyToolChangeRejection(apiError(400, 'tool_addition is malformed'))).toBe('other')
  })

  test('unrelated errors are not tool-change rejections', () => {
    expect(classifyToolChangeRejection(apiError(400, 'prompt is too long'))).toBeUndefined()
    expect(classifyToolChangeRejection(apiError(500, 'tool_addition overloaded'))).toBeUndefined()
    expect(classifyToolChangeRejection(new Error('tool_addition'))).toBeUndefined()
  })
})

describe('isSystemTurnRejection', () => {
  test('rejections of the role:"system" turn', () => {
    expect(isSystemTurnRejection(apiError(400, "messages.3.role: Input should be 'user' or 'assistant'"))).toBe(true)
    expect(isSystemTurnRejection(codedError(400, 'mid_conversation_system_not_supported', 'x'))).toBe(true)
    expect(isSystemTurnRejection(apiError(400, `Unexpected value(s) \`${MID_CONVERSATION_SYSTEM_BETA_HEADER}\` for the \`anthropic-beta\` header`))).toBe(true)
    expect(isSystemTurnRejection(apiError(400, 'messages.4: role "system" must follow a user turn'))).toBe(true)
  })

  test('other errors are not', () => {
    expect(isSystemTurnRejection(apiError(400, 'prompt is too long'))).toBe(false)
    expect(isSystemTurnRejection(codedError(400, 'mid_conversation_tool_changes_not_supported', 'x'))).toBe(false)
    expect(isSystemTurnRejection(new Error("Input should be 'user' or 'assistant'"))).toBe(false)
  })
})
