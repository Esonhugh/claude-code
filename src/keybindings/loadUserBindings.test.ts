import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getKeybindingsPath,
  isKeybindingCustomizationEnabled,
  loadKeybindings,
  loadKeybindingsSyncWithWarnings,
  resetKeybindingLoaderForTesting,
} from './loadUserBindings.js'

const envKeys = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY'] as const
let saved: (string | undefined)[] = []
let root: string | undefined

beforeEach(async () => {
  saved = envKeys.map(key => process.env[key])
  root = await realpath(await mkdtemp(join(tmpdir(), 'keybindings-load-')))
  process.env.CLAUDE_CONFIG_DIR = root
  // GrowthBook stays off without Anthropic telemetry, as for every fork user.
  delete process.env.CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY
  resetKeybindingLoaderForTesting()
})

afterEach(async () => {
  resetKeybindingLoaderForTesting()
  envKeys.forEach((key, index) => {
    if (saved[index] === undefined) delete process.env[key]
    else process.env[key] = saved[index]
  })
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

test('keybindings.json is loaded without GrowthBook, matching official 2.1.303', async () => {
  expect(isKeybindingCustomizationEnabled()).toBe(true)
  const path = getKeybindingsPath()
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(
    path,
    JSON.stringify({
      bindings: [{ context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor' } }],
    }),
  )
  const isCustom = (binding: { action: string | null; context: string; chord: { key: string; ctrl: boolean }[] }) =>
    binding.context === 'Chat' &&
    binding.action === 'chat:externalEditor' &&
    binding.chord.length === 1 &&
    binding.chord[0]!.key === 'e' &&
    binding.chord[0]!.ctrl
  expect(loadKeybindingsSyncWithWarnings().bindings.some(isCustom)).toBe(true)
  expect((await loadKeybindings()).bindings.some(isCustom)).toBe(true)
})
