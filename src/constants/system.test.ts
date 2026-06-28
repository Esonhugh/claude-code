import { describe, expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

describe('getAttributionHeader', () => {
  test('CLAUDE_CODE_ATTRIBUTION_HEADER=1 forces attribution on', async () => {
    const previous = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '1'

    try {
      const { getAttributionHeader } = await import('./system.js')

      expect(getAttributionHeader('abcde')).toContain(
        'x-anthropic-billing-header:',
      )
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
      } else {
        process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = previous
      }
    }
  })

  test('first-party API includes cch attestation placeholder', async () => {
    const previousAttribution = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
    const previousBaseUrl = process.env.ANTHROPIC_BASE_URL
    const previousOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
    const previousBedrock = process.env.CLAUDE_CODE_USE_BEDROCK
    const previousVertex = process.env.CLAUDE_CODE_USE_VERTEX
    const previousFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY

    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '1'
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY

    try {
      const { getAttributionHeader } = await import('./system.js')

      expect(getAttributionHeader('abcde')).toContain('cch=00000;')
    } finally {
      if (previousAttribution === undefined) {
        delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
      } else {
        process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = previousAttribution
      }
      if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = previousBaseUrl
      if (previousOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
      else process.env.CLAUDE_CODE_USE_OPENAI = previousOpenAI
      if (previousBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK
      else process.env.CLAUDE_CODE_USE_BEDROCK = previousBedrock
      if (previousVertex === undefined) delete process.env.CLAUDE_CODE_USE_VERTEX
      else process.env.CLAUDE_CODE_USE_VERTEX = previousVertex
      if (previousFoundry === undefined) delete process.env.CLAUDE_CODE_USE_FOUNDRY
      else process.env.CLAUDE_CODE_USE_FOUNDRY = previousFoundry
    }
  })

  test('_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL enables cch for first-party proxy', async () => {
    const previousAttribution = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
    const previousBaseUrl = process.env.ANTHROPIC_BASE_URL
    const previousAssumeFirstParty =
      process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL
    const previousOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
    const previousBedrock = process.env.CLAUDE_CODE_USE_BEDROCK
    const previousVertex = process.env.CLAUDE_CODE_USE_VERTEX
    const previousFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY

    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '1'
    process.env.ANTHROPIC_BASE_URL = 'https://ai-gw.mjclouds.com'
    process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY

    try {
      const { getAttributionHeader } = await import('./system.js')

      expect(getAttributionHeader('abcde')).toContain('cch=00000;')
    } finally {
      if (previousAttribution === undefined) {
        delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
      } else {
        process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = previousAttribution
      }
      if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = previousBaseUrl
      if (previousAssumeFirstParty === undefined) {
        delete process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL
      } else {
        process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL =
          previousAssumeFirstParty
      }
      if (previousOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
      else process.env.CLAUDE_CODE_USE_OPENAI = previousOpenAI
      if (previousBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK
      else process.env.CLAUDE_CODE_USE_BEDROCK = previousBedrock
      if (previousVertex === undefined) delete process.env.CLAUDE_CODE_USE_VERTEX
      else process.env.CLAUDE_CODE_USE_VERTEX = previousVertex
      if (previousFoundry === undefined) delete process.env.CLAUDE_CODE_USE_FOUNDRY
      else process.env.CLAUDE_CODE_USE_FOUNDRY = previousFoundry
    }
  })
})
