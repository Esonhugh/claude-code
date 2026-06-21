#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const testDir = dirname(fileURLToPath(import.meta.url))
const loginSource = await readFile(join(testDir, 'login.tsx'), 'utf-8')
const openAIFlowMatch = loginSource.match(/<OpenAIOAuthFlow[\s\S]*?\/>/)

assert.notEqual(openAIFlowMatch, null)
assert.match(openAIFlowMatch![0], /onDone=\{\(\) => props\.onDone\(true, mainLoopModel\)\}/)
assert.match(openAIFlowMatch![0], /onExit=\{\(\) => props\.onDone\(false, mainLoopModel\)\}/)

console.log('openai-login-exit.test.ts passed')
