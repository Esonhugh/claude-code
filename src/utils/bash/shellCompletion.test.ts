import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getShellCompletions } from './shellCompletion.js'

let home: string
const savedEnv = { HOME: process.env.HOME, SHELL: process.env.SHELL }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shell-completion-'))
  mkdirSync(join(home, 'qt-demo'))
  process.env.HOME = home
  process.env.SHELL = '/bin/bash'
})

afterEach(() => {
  process.env.HOME = savedEnv.HOME
  process.env.SHELL = savedEnv.SHELL
  rmSync(home, { recursive: true, force: true })
})

test('file completion keeps the ~/ prefix the user typed', async () => {
  const input = 'ls ~/qt-de'
  const items = await getShellCompletions(
    input,
    input.length,
    new AbortController().signal,
  )
  expect(items.map(item => item.displayText)).toEqual(['~/qt-demo/'])
})
