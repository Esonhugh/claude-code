import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tools } from '../Tool.js'
import { resetStateForTests, setIsInteractive } from '../bootstrap/state.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import { getSystemPromptFacts, getSystemPromptSections, renderSystemPrompt } from '../utils/systemPromptType.js'
import { getAutoMemPath } from '../memdir/paths.js'
import type { PromptComposeInput } from '../services/mods/types.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test', ISSUES_EXPLAINER: 'report an issue' }
const { getSystemPrompt } = await import('./prompts.js')
const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY']
let saved: (string | undefined)[]
let root: string
beforeEach(async () => {
  saved = keys.map(key => process.env[key])
  root = await realpath(await mkdtemp(join(tmpdir(), 'prompt-compose-facts-')))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.ANTHROPIC_API_KEY = 'sk-compose-facts-placeholder'
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.CLAUDE_CODE_SIMPLE
  resetSettingsCache()
  resetStateForTests()
  setIsInteractive(false)
})
afterEach(async () => {
  getAutoMemPath.cache.clear?.()
  resetSettingsCache()
  resetStateForTests()
  keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  await rm(root, { recursive: true, force: true })
})

const input: PromptComposeInput = {
  model: 'claude-opus-4-6', promptModel: 'claude-opus-4-6', tools: [], outputStyle: null, traits: ['print'], surfaces: [],
}

// Official 2.1.292 measured: next() ignores these observational fields, including an unknown style.
test.each([
  { promptModel: 'claude-sonnet-5-5' },
  { outputStyle: { name: 'Explanatory', isKeepingCodingInstructions: false } },
  { outputStyle: { name: 'missing-style', isKeepingCodingInstructions: false } },
])('the composition recipe derives model and style from the engine for %j', async change => {
  const generated = await getSystemPrompt([], input.model)
  const baseline = await renderSystemPrompt(generated, input)
  const rewritten = await renderSystemPrompt(generated, { ...input, ...change })
  expect([...rewritten]).toEqual([...baseline])
  expect(getSystemPromptSections(rewritten)).toEqual(getSystemPromptSections(baseline))
  expect(getSystemPromptFacts(rewritten)).toEqual(getSystemPromptFacts(baseline))
})

test('a detached composition for another request model renders that model rather than its observational promptModel', async () => {
  const generated = await getSystemPrompt([], input.model)
  const rewritten = await renderSystemPrompt(generated, { ...input, model: 'claude-sonnet-4-6', promptModel: 'ignored' })
  expect(getSystemPromptFacts(rewritten)?.promptModel).toBe('claude-sonnet-4-6')
  expect(rewritten.join('\n')).toContain('The exact model ID is claude-sonnet-4-6')
  expect(rewritten.join('\n')).not.toContain('The exact model ID is ignored')
})

test('the composition tools select only tools offered by the engine, with unknown names ignored', async () => {
  const generated = await getSystemPrompt([{ name: 'Bash' }] as unknown as Tools, input.model)
  const empty = await renderSystemPrompt(generated, input)
  const unknown = await renderSystemPrompt(generated, { ...input, tools: ['TaskCreate', 'invented-tool'] })
  expect([...unknown]).toEqual([...empty])
  expect(getSystemPromptSections(unknown)).toEqual(getSystemPromptSections(empty))
})
