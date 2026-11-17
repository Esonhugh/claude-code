import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { ADVISOR_BETA_HEADER } from '../../constants/betas.js'
import {
  classifyAdvisorRefusal,
  isAdvisorIncompatibleError,
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
