import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetStateForTests, setIsInteractive } from '../bootstrap/state.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import { getSystemPromptFacts, getSystemPromptSections } from '../utils/systemPromptType.js'
import fixture from './fixtures/leanPrompt292.json'
import { getAutoMemPath } from '../memdir/paths.js'
import { clearSystemPromptSections } from './systemPromptSections.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test', ISSUES_EXPLAINER: 'report an issue' }
const { getSystemPrompt } = await import('./prompts.js')
const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_MODEL_CAPABILITIES', 'CLAUDE_CODE_INTRO_FRAME', 'CLAUDE_CODE_USE_OPENAI', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_TURN_UPDATES']
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

// The fork never sends mid-conversation system turns (#409), so the body always names <system-reminder> tags.
const SYSTEM_TURN_REMINDER = 'The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results.'
const TAG_REMINDER = '`<system-reminder>` tags in messages and tool results are injected by the harness, not the user.'

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
    expect(sections.filter(s => 'scope' in s && s.scope === 'shared' && 'text' in s && s.text)).toEqual([{ name: 'lean_body', scope: 'shared', text: sample.core.find(s => s.id === 'lean_body')!.text.replace(`${fixture.securityInstruction}\n\n`, '').replace(LEAN_INTRO_292, LEAN_INTRO_303).replace(SYSTEM_TURN_REMINDER, TAG_REMINDER) }])
    for (const section of sample.core.filter(s => s.id !== 'lean_body')) {
      expect(sections.find(s => 'name' in s && s.name === section.id)).toEqual({ name: section.id, scope: 'session', text: section.text })
    }
  } else expect(sections[0]).not.toMatchObject({ name: 'lean_body' })
})

// Official 2.1.311 Qnr/Snn: lean drops Agent/Explore/AskUserQuestion bullets; every prompt ends with
// context_management + act_dont_rederive and no summarize_tool_results section.
test('session guidance and tail sections match official 2.1.311', async () => {
  const tools = [{ name: 'Agent' }, { name: 'AskUserQuestion' }, { name: 'Skill' }] as unknown as Parameters<typeof getSystemPrompt>[0]
  const text = (prompt: string[]) => getSystemPromptSections(prompt)!.map(s => 'text' in s ? s.text ?? '' : '').join('\n\n')
  const lean = text(await getSystemPrompt(tools, 'claude-opus-5-5'))
  expect(lean).not.toContain('Use the Agent tool with specialized agents')
  expect(lean).not.toContain('subagent_type=Explore')
  expect(lean).not.toContain('use the AskUserQuestion to ask them')
  expect(getSystemPromptSections(await getSystemPrompt(tools, 'claude-opus-5-5'))!.find(s => 'name' in s && s.name === 'session_guidance'))
    .toMatchObject({ text: "# Session-specific guidance\n - When the user types `/<skill-name>`, invoke it via Skill. Only use skills listed in the user-invocable skills section — don't guess." })
  expect(lean).not.toContain('write down any important information')
  expect(lean).toContain('# Context management\nWhen the conversation grows long, some or all of the current context is summarized;')
  expect(lean).toContain('When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey')
  const full = text(await getSystemPrompt(tools, 'claude-sonnet-4-6'))
  expect(full).toContain('Use the Agent tool with specialized agents')
  expect(full).toContain("For broad codebase exploration or research that'll take more than 3 queries, spawn Agent with subagent_type=Explore. Otherwise use ")
  expect(full).not.toContain('For simple, directed codebase searches')
  expect(full).toContain('# Context management')
  process.env.CLAUDE_CODE_ACT_DONT_REDERIVE = '0'
  clearSystemPromptSections()
  try {
    expect(text(await getSystemPrompt(tools, 'claude-opus-5-5'))).not.toContain('When you have enough information to act, act.')
  } finally { delete process.env.CLAUDE_CODE_ACT_DONT_REDERIVE }
})
