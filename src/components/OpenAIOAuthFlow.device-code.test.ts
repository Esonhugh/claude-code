#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'

const source = readFileSync(new URL('./OpenAIOAuthFlow.tsx', import.meta.url), 'utf-8')

assert.match(source, /type LoginMethod = 'api_key' \| 'oauth' \| 'device_code' \| 'exit'/)
assert.match(source, /Sign in with device code/)
assert.match(source, /Enter this one-time code/)
assert.match(source, /Never share this code/)
assert.match(source, /loginOpenAIWithDeviceCode/)

console.log('OpenAIOAuthFlow.device-code.test.ts passed')
