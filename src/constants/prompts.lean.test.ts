import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetStateForTests, setIsInteractive } from '../bootstrap/state.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import { getSystemPromptFacts, getSystemPromptSections } from '../utils/systemPromptType.js'
import fixture from './fixtures/leanPrompt292.json'
import { getAutoMemPath } from '../memdir/paths.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test', ISSUES_EXPLAINER: 'report an issue' }
const { getSystemPrompt } = await import('./prompts.js')
const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_MODEL_CAPABILITIES', 'CLAUDE_CODE_INTRO_FRAME', 'CLAUDE_CODE_USE_OPENAI', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_TURN_UPDATES', 'CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM']
let saved: (string | undefined)[]
let root: string
beforeEach(async () => {
  saved = keys.map(key => process.env[key])
  root = await realpath(await mkdtemp(join(tmpdir(), 'prompt-lean-')))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.ANTHROPIC_API_KEY = 'sk-lean-placeholder'
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT
  for (const key of keys.slice(7)) delete process.env[key]
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

// Official 2.1.292 measured: the default Sonnet 5.5 prompt starts with shared lean_body.
test('Sonnet 5.5 selects the official lean body and advertises its lean trait', async () => {
  const prompt = await getSystemPrompt([], 'claude-sonnet-5-5')
  expect(getSystemPromptFacts(prompt)?.traits).toContain('lean')
  expect(getSystemPromptSections(prompt)?.[0]).toMatchObject({ name: 'lean_body', scope: 'shared' })
})

// The fixture predates official 2.1.303, which ships tengu_ochre_wren on (LOCAL_GA_DEFAULTS).
const LEAN_INTRO_292 = 'You are an interactive agent that helps users with software engineering tasks.'
const LEAN_INTRO_303 = 'You are an agent working with the user toward their goals, using your own judgment along the way.'

// Official 2.1.292 actual API runs: core strings/scopes captured with each model/override.
test.each(fixture.cases)('matches official lean selection and core sections for $name', async sample => {
  Object.assign(process.env, sample.env ?? {})
  if ('style' in sample) {
    await mkdir(join(root, 'config'), { recursive: true })
    await writeFile(join(root, 'config', 'settings.json'), JSON.stringify({ outputStyle: sample.style }))
    resetSettingsCache()
  }
  const prompt = await getSystemPrompt([], sample.model)
  expect(getSystemPromptFacts(prompt)?.traits.includes('lean')).toBe(sample.lean)
  const sections = getSystemPromptSections(prompt)!
  if (sample.lean) {
    expect(sections.filter(s => 'scope' in s && s.scope === 'shared' && 'text' in s && s.text)).toEqual([{ name: 'lean_body', scope: 'shared', text: sample.core.find(s => s.id === 'lean_body')!.text.replace(fixture.securityInstruction, '').replace(LEAN_INTRO_292, LEAN_INTRO_303) }])
    for (const section of sample.core.filter(s => s.id !== 'lean_body')) {
      expect(sections.find(s => 'name' in s && s.name === section.id)).toEqual({ name: section.id, scope: 'session', text: section.text })
    }
  } else expect(sections[0]).not.toMatchObject({ name: 'lean_body' })
})
