#!/usr/bin/env node
import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const { shouldRunLoginSuccessSideEffects } = await import('./login.js')

assert.equal(shouldRunLoginSuccessSideEffects(false), false)
assert.equal(shouldRunLoginSuccessSideEffects(true), true)

console.log('openai-login-cancel-side-effects.test.ts passed')
