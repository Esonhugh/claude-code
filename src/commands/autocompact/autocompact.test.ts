import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as api from '../../services/api/claude.js'
import type { ToolUseContext } from '../../Tool.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { stepAutoCompactWindow } from './autocompact.js'
import {
  applyAutoCompactWindow,
  call,
  describeAutoCompactWindow,
} from './autocompact-noninteractive.js'

const envKeys = [
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
] as const
let root: string
let saved: (string | undefined)[]
let restoreMaxOutput: () => void

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'autocompact-command-'))
  saved = envKeys.map(key => process.env[key])
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  for (const key of envKeys.slice(2)) delete process.env[key]
  const maxOutput = spyOn(api, 'getMaxOutputTokensForModel').mockReturnValue(4096)
  restoreMaxOutput = () => maxOutput.mockRestore()
  resetSettingsCache()
})

afterEach(async () => {
  restoreMaxOutput()
  envKeys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key]
    else process.env[key] = saved[i]
  })
  resetSettingsCache()
  await rm(root, { recursive: true, force: true })
})

async function userSettings(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(root, 'config', 'settings.json'), 'utf-8'),
  )
}

test('saves the window per model in user settings', async () => {
  expect(applyAutoCompactWindow('150k', 'claude-haiku-4-5-20251001')).toBe(
    'Auto-compact window for Haiku 4.5 set to 150k tokens',
  )
  expect(await userSettings()).toEqual({
    modelSettings: { 'claude-haiku-4-5': { autoCompactWindow: 150_000 } },
  })
  expect(describeAutoCompactWindow('claude-haiku-4-5-20251001')).toStartWith(
    'Auto-compact window for Haiku 4.5: 150k tokens (from settings)',
  )

  expect(applyAutoCompactWindow('reset', 'claude-haiku-4-5-20251001')).toBe(
    'Auto-compact window for Haiku 4.5 set to auto',
  )
  expect(await userSettings()).toEqual({
    modelSettings: { 'claude-haiku-4-5': { autoCompactWindow: 'auto' } },
  })
  expect(describeAutoCompactWindow('claude-haiku-4-5-20251001')).toStartWith(
    'Auto-compact window for Haiku 4.5: auto\n',
  )
})

test('reports a window larger than the model limit as capped', () => {
  expect(applyAutoCompactWindow('500k', 'claude-haiku-4-5-20251001')).toBe(
    'Auto-compact window for Haiku 4.5 set to 500k tokens (capped to model limit of 200k)',
  )
  expect(describeAutoCompactWindow('claude-haiku-4-5-20251001')).toContain(
    '500k tokens (from settings) · capped to 200k by model',
  )
  // Capped to the model limit, so it is no larger than auto: no usage warning.
  expect(describeAutoCompactWindow('claude-haiku-4-5-20251001')).not.toContain(
    'Overriding auto',
  )
})

test('works for third-party model names', () => {
  expect(applyAutoCompactWindow('200', 'gpt-5.5')).toBe(
    'Auto-compact window for gpt-5.5 set to 200k tokens',
  )
})

test('warns about token usage only when the window exceeds auto', () => {
  // Sonnet 5 has a 1M window and auto-compacts at 967K by default.
  applyAutoCompactWindow('1m', 'claude-sonnet-5')
  expect(describeAutoCompactWindow('claude-sonnet-5')).toContain(
    'Overriding auto may result in high token usage',
  )
  applyAutoCompactWindow('500k', 'claude-sonnet-5')
  expect(describeAutoCompactWindow('claude-sonnet-5')).not.toContain(
    'Overriding auto',
  )
})

test('rejects unparseable values and defers to the environment variable', () => {
  expect(applyAutoCompactWindow('lots', 'claude-haiku-4-5-20251001')).toBe(
    "Couldn't parse 'lots'. Expected 'auto' or 100k–1M tokens (e.g. 500k, 200000, or 200 as shorthand)",
  )
  expect(applyAutoCompactWindow('50k', 'claude-haiku-4-5-20251001')).toStartWith(
    "Couldn't parse '50k'.",
  )
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '150000'
  expect(applyAutoCompactWindow('300k', 'claude-haiku-4-5-20251001')).toBe(
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW is set and takes precedence. Unset it to change this setting.',
  )
})

test('the non-interactive command shows the window without arguments', async () => {
  const context = {
    options: { mainLoopModel: 'claude-haiku-4-5-20251001' },
  } as ToolUseContext
  const shown = await call('', context)
  expect(shown.value).toStartWith('Auto-compact window for Haiku 4.5: ')
  expect(shown.value).toContain(
    "The actual threshold is the minimum of this setting and your model's maximum context window.",
  )
  expect((await call(' 120k ', context)).value).toBe(
    'Auto-compact window for Haiku 4.5 set to 120k tokens',
  )
})

test('the dialog stepper wraps through auto', () => {
  expect(stepAutoCompactWindow(0, 1)).toBe(100_000)
  expect(stepAutoCompactWindow(0, -1)).toBe(1_000_000)
  expect(stepAutoCompactWindow(100_000, 1)).toBe(200_000)
  expect(stepAutoCompactWindow(100_000, -1)).toBe(0)
  expect(stepAutoCompactWindow(1_000_000, 1)).toBe(0)
})
