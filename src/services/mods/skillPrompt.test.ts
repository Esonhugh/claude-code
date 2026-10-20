import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command, PromptCommand } from '../../types/command.js'
import { createModsRuntime } from './runtime.js'
import { modSkillPromptOrigin, renderModSkillPrompt } from './skillPrompt.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

const diagnostics: string[] = []
async function render(handler: string, command: Command & PromptCommand) {
  const root = await mkdtemp(join(tmpdir(), 'mods-skill-origin-'))
  const entry = join(root, 'register.ts')
  await writeFile(entry, `export function register(on) { on('skill.prompt', ${handler}); }`)
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event.message) })
  cleanups.push(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })
  await runtime.reconcile([{ name: 'reader', storageId: 'reader@inline', pluginRoot: root, entrypoints: [entry] }])
  const snapshot = runtime.capture()
  try {
    return await renderModSkillPrompt({
      snapshot, skill: command.name, text: 'body', origin: modSkillPromptOrigin(command), signal: new AbortController().signal,
    }).catch((error: Error) => `error: ${error.message}`)
  } finally { snapshot.release() }
}

const command = (changes: Partial<PromptCommand>): Command & PromptCommand => ({
  type: 'prompt', name: 'commit', description: 'Commit', progressMessage: 'loading', contentLength: 0, source: 'userSettings',
  async getPromptForCommand() { return [] },
  ...changes,
}) as Command & PromptCommand

test('skill.prompt carries the frontmatter, source, plugin name and path of the skill file', async () => {
  const frontmatter = JSON.parse('{"description":"Commit","allowed-tools":["Bash"],"__proto__":{"x":1},"constructor":1}')
  const plugin = command({
    source: 'plugin',
    pluginInfo: { pluginManifest: { name: 'tools' } as never, repository: 'tools@market' },
    skillFile: { path: '/skills/commit/SKILL.md', frontmatter },
  })
  expect(JSON.parse(await render(`($, e) => ({text: JSON.stringify({...e, text: undefined})})`, plugin))).toEqual({
    skill: 'commit',
    frontmatter: { description: 'Commit', 'allowed-tools': ['Bash'] },
    source: 'plugin',
    pluginName: 'tools',
    path: '/skills/commit/SKILL.md',
  })
  expect(JSON.parse(await render(`($, e) => ({text: JSON.stringify(e)})`, command({ source: 'bundled' })))).toEqual({
    skill: 'commit', text: 'body', frontmatter: {}, source: 'built-in',
  })
})

test('skill.prompt lets a hook rewrite text and frontmatter, restores omitted pinned fields and refuses changed ones', async () => {
  const projectSkill = command({ source: 'projectSettings', skillFile: { path: '/repo/.claude/skills/commit/SKILL.md', frontmatter: {} } })
  expect(await render(`($, e, next) => next({skill: e.skill, text: e.text + '!', frontmatter: {model: 'x'}})`, projectSkill))
    .toBe('body!')
  expect(diagnostics).toEqual([])
  // A changed pinned field fails the hook, which is then absent: core's text stands.
  expect(await render(`($, e, next) => next({...e, text: 'moved', source: 'policySettings'})`, projectSkill)).toBe('body')
  expect(await render(`($, e, next) => next({...e, text: 'moved', path: '/elsewhere'})`, projectSkill)).toBe('body')
  expect(diagnostics).toEqual([
    expect.stringContaining('skill.prompt cannot rewrite source'),
    expect.stringContaining('skill.prompt cannot rewrite path'),
  ])
})
