#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  'src/commands/terminal/terminal.tsx',
  'utf8',
)

assert.match(source, /<BackgroundTasksDialog/)
assert.match(source, /scope="terminal"/)

console.log('terminal.behavior.test.ts passed')
