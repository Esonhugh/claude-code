#!/usr/bin/env node
import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const { copyOpenAIAuthUrlToClipboard } = await import('./clipboard.js')

const writes: string[] = []
const result = await copyOpenAIAuthUrlToClipboard('https://auth.openai.com/oauth/authorize?client_id=test', {
  setClipboard: async text => {
    assert.equal(text, 'https://auth.openai.com/oauth/authorize?client_id=test')
    return '\u001b]52;c;encoded\u0007'
  },
  writeStdout: text => {
    writes.push(text)
  },
})

assert.equal(result, true)
assert.deepEqual(writes, ['\u001b]52;c;encoded\u0007'])

const failedResult = await copyOpenAIAuthUrlToClipboard('https://auth.openai.com/oauth/authorize?client_id=test', {
  setClipboard: async () => {
    throw new Error('clipboard unavailable')
  },
  writeStdout: text => {
    writes.push(text)
  },
})

assert.equal(failedResult, false)
assert.deepEqual(writes, ['\u001b]52;c;encoded\u0007'])

console.log('openai-oauth clipboard.test.ts passed')
