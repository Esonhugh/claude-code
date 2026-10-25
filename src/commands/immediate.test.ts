import { afterEach, expect, test } from 'bun:test'
import '../commands.js'
import addDir from './add-dir/index.js'
import config from './config/index.js'
import diff from './diff/index.js'
import feedback from './feedback/index.js'
import help from './help/index.js'
import permissions from './permissions/index.js'
import skills from './skills/index.js'
import stats from './stats/index.js'
import tasks from './tasks/index.js'
import theme from './theme/index.js'
import {
  isCommandImmediate,
  type LocalJSXCommandContext,
} from '../types/command.js'

// Official 2.1.303 opens these local-jsx commands while a turn is running
// instead of queueing them behind it.
const context = {} as LocalJSXCommandContext
const originalNoFlicker = process.env.CLAUDE_CODE_NO_FLICKER

afterEach(() => {
  if (originalNoFlicker === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
  else process.env.CLAUDE_CODE_NO_FLICKER = originalNoFlicker
})

test.each([
  ['permissions', permissions],
  ['skills', skills],
  ['tasks', tasks],
  ['feedback', feedback],
  ['stats', stats],
] as const)('/%s is always immediate', (_name, command) => {
  expect(isCommandImmediate(command, '', context)).toBe(true)
})

test.each([
  ['help', help],
  ['theme', theme],
  ['config', config],
  ['add-dir', addDir],
  ['diff', diff],
] as const)('/%s is immediate only in fullscreen without args', (_name, command) => {
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  expect(isCommandImmediate(command, '', context)).toBe(false)
  process.env.CLAUDE_CODE_NO_FLICKER = '1'
  expect(isCommandImmediate(command, '', context)).toBe(true)
})

test('/add-dir with a path is immediate outside fullscreen', () => {
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  expect(isCommandImmediate(addDir, '/tmp', context)).toBe(true)
})

test('/diff follows fullscreen, not terminal width', () => {
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  const wide = {
    modCommand: { presentation: { columns: 200 } },
  } as LocalJSXCommandContext
  expect(isCommandImmediate(diff, '', wide)).toBe(false)
})
