#!/usr/bin/env node
import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const { createOpenAIAuthFlowCancellation } = await import('./OpenAIOAuthFlow.js')

const cancellation = createOpenAIAuthFlowCancellation()
assert.equal(cancellation.isCancelled(), false)
cancellation.cancel()
assert.equal(cancellation.isCancelled(), true)

console.log('OpenAIOAuthFlow.cancel.test.ts passed')
