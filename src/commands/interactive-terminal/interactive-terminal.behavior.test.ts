#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  'src/commands/interactive-terminal/interactive-terminal.tsx',
  'utf8',
)

assert.match(source, /<BackgroundTasksDialog/)
assert.match(source, /scope="interactive-terminal"/)

console.log('interactive-terminal.behavior.test.ts passed')
