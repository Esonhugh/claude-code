import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetStateForTests, setIsInteractive } from '../bootstrap/state.js'
import { memoryPromptForTools } from '../memdir/memdir.js'
import { getAutoMemPath } from '../memdir/paths.js'
import type { Tool, Tools } from '../Tool.js'
import { resetCodeModeGateForTesting, settleCodeModeGate } from '../tools/REPLTool/codeModeGate.js'
import { BASE_CHROME_PROMPT, getChromeSystemPrompt } from '../utils/claudeInChrome/prompt.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import { getSystemPromptSections } from '../utils/systemPromptType.js'
import { clearSystemPromptSections } from './systemPromptSections.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test', ISSUES_EXPLAINER: 'report an issue' }
const { getSystemPrompt, getUsingYourToolsSection } = await import('./prompts.js')

const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_REPL', 'CLAUDE_REPL_MODE', 'USER_TYPE']
let saved: (string | undefined)[]
let root: string

function tool(name: string): Tool {
  return { name } as Tool
}

const pool: Tools = [tool('REPL'), tool('Poll'), tool('Write'), tool('Edit'), tool('TodoWrite')]
const MEMORY = 'This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).'

function codeModeOn(): void {
  process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  setIsInteractive(true)
  settleCodeModeGate({ remoteControl: false, remote: false })
}

beforeEach(async () => {
  saved = keys.map(key => process.env[key])
  root = await realpath(await mkdtemp(join(tmpdir(), 'prompt-code-mode-')))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.ANTHROPIC_API_KEY = 'sk-code-mode-placeholder'
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  for (const key of keys.slice(3)) if (key !== 'CLAUDE_CODE_DISABLE_AUTO_MEMORY') delete process.env[key]
  resetSettingsCache()
  resetStateForTests()
  resetCodeModeGateForTesting()
  clearSystemPromptSections()
  setIsInteractive(false)
})

afterEach(async () => {
  getAutoMemPath.cache.clear?.()
  resetSettingsCache()
  resetStateForTests()
  resetCodeModeGateForTesting()
  clearSystemPromptSections()
  keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  await rm(root, { recursive: true, force: true })
})

test('with Code Mode off the prompt is byte-identical with or without a REPL tool in the pool', async () => {
  // Code Mode asked for but refused (not interactive) is off too.
  for (const arrange of [() => {}, () => { process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1' }]) {
    arrange()
    resetCodeModeGateForTesting()
    clearSystemPromptSections()
    const withRepl = await getSystemPrompt(pool, 'claude-opus-5-5')
    clearSystemPromptSections()
    const withoutRepl = await getSystemPrompt(pool.filter(t => t.name !== 'REPL' && t.name !== 'Poll'), 'claude-opus-5-5')
    expect(withRepl.join('\n')).toBe(withoutRepl.join('\n'))
    expect(withRepl.join('\n')).not.toContain('REPL script')
  }
  expect(getUsingYourToolsSection(new Set(pool.map(t => t.name)))).toContain('Prefer dedicated tools over Bash')
  expect(memoryPromptForTools(MEMORY, pool)).toBe(MEMORY)
  expect(getChromeSystemPrompt()).toBe(BASE_CHROME_PROMPT)
})

test('Code Mode with REPL uses the official tools section', () => {
  codeModeOn()
  expect(getUsingYourToolsSection(new Set(pool.map(t => t.name)))).toBe(
    '# Using your tools\n - Break down and manage your work with the TodoWrite tool. These tools are helpful for planning your work and helping the user track your progress. Mark each task as completed as soon as you are done with the task. Do not batch up multiple tasks before marking them as completed.',
  )
  // A pool without REPL still has its primitives, so it keeps the ordinary text.
  expect(getUsingYourToolsSection(new Set(['Write', 'Bash']))).toContain('Prefer dedicated tools over Bash')
})

test('Code Mode with REPL writes memory files from a script (official O0o)', () => {
  codeModeOn()
  expect(memoryPromptForTools(MEMORY, pool)).toBe(
    'This directory already exists — write to it directly with `write(path, content)` in a REPL script (do not run mkdir or check for its existence).',
  )
  expect(memoryPromptForTools(MEMORY, pool.filter(t => t.name !== 'REPL'))).toBe(MEMORY)
  expect(memoryPromptForTools(null, pool)).toBeNull()
})

test('Code Mode adds the official repl_working section last, only on the full prompt (official s7r)', async () => {
  const REPL_WORKING = "Few, full scripts: do a turn's investigating in as few REPL calls as the dependencies between its steps allow, reading and searching more widely than you strictly need, because each extra call is a round trip and each extra read inside one is nearly free."
  const names = (prompt: string[]) => (getSystemPromptSections(prompt) ?? []).flatMap(s => 'name' in s && s.text !== null && s.name ? [s.name] : [])
  const off = await getSystemPrompt(pool, 'claude-sonnet-4-6')
  expect(off.join('\n')).not.toContain('Few, full scripts')
  codeModeOn()
  clearSystemPromptSections()
  const full = await getSystemPrompt(pool, 'claude-sonnet-4-6')
  expect(full.at(-1)).toBe(REPL_WORKING)
  expect(names(full).at(-1)).toBe('repl_working')
  clearSystemPromptSections()
  expect((await getSystemPrompt(pool, 'claude-opus-5-5')).join('\n')).not.toContain('Few, full scripts')
})
