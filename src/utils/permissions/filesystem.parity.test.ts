import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolPermissionContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { getCwdState, getOriginalCwd, setCwdState, setOriginalCwd } = await import('../../bootstrap/state.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { checkWritePermissionForTool, generateSuggestions, matchingRuleForInput } = await import('./filesystem.js')

const project = realpathSync(mkdtempSync(join(tmpdir(), 'fs-permission-parity-')))
const savedCwd = getCwdState()
const savedOriginalCwd = getOriginalCwd()
setOriginalCwd(project)
setCwdState(project)
afterAll(() => {
  setOriginalCwd(savedOriginalCwd)
  setCwdState(savedCwd)
  rmSync(project, { recursive: true, force: true })
})

function permissionContext(
  mode: ToolPermissionContext['mode'],
  rules: { allow?: string[]; deny?: string[]; ask?: string[] } = {},
): ToolPermissionContext {
  return {
    ...getDefaultAppState().toolPermissionContext,
    mode,
    alwaysAllowRules: { session: rules.allow ?? [] },
    alwaysDenyRules: { session: rules.deny ?? [] },
    alwaysAskRules: { session: rules.ask ?? [] },
  } as ToolPermissionContext
}

test('a single-segment dir/** allow rule only covers <cwd>/dir', () => {
  const ctx = permissionContext('default', { allow: ['Edit(src/**)'] })
  expect(matchingRuleForInput(join(project, 'src/x.ts'), ctx, 'edit', 'allow')).not.toBeNull()
  expect(matchingRuleForInput(join(project, 'src/deep/x.ts'), ctx, 'edit', 'allow')).not.toBeNull()
  expect(matchingRuleForInput(join(project, 'a/src/x.ts'), ctx, 'edit', 'allow')).toBeNull()
})

test('single-segment dir/** deny and ask rules still match at any depth', () => {
  for (const behavior of ['deny', 'ask'] as const) {
    const ctx = permissionContext('default', { [behavior]: ['Edit(src/**)'] })
    expect(matchingRuleForInput(join(project, 'src/x.ts'), ctx, 'edit', behavior)).not.toBeNull()
    expect(matchingRuleForInput(join(project, 'a/src/x.ts'), ctx, 'edit', behavior)).not.toBeNull()
  }
})

test('other allow patterns keep their matching', () => {
  const ctx = permissionContext('default', { allow: ['Edit(*.md)', 'Edit(a/src/**)'] })
  expect(matchingRuleForInput(join(project, 'docs/readme.md'), ctx, 'edit', 'allow')).not.toBeNull()
  expect(matchingRuleForInput(join(project, 'a/src/x.ts'), ctx, 'edit', 'allow')).not.toBeNull()
})

const writeTool = {
  name: 'Write',
  getPath: (input: { file_path: string }) => input.file_path,
} as unknown as Tool

test.each([
  '.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', '.bunfig.toml', '.bazelrc', '.bazelversion', '.bazeliskrc',
  '.pre-commit-config.yaml', 'lefthook.yml', '.lefthook.yaml', '.pnp.cjs', '.pnp.loader.mjs', '.pnpmfile.cjs',
  'gradle/wrapper/gradle-wrapper.properties', '.mvn/wrapper/maven-wrapper.properties', '.devcontainer.json',
  'pyrightconfig.json', '.envrc', '.zshenv', '.zlogin', '.zlogout', '.bash_login', '.bash_aliases', '.bash_logout',
  '.husky/pre-commit', '.devcontainer/devcontainer.json', '.cargo/config.toml', '.yarn/releases/yarn.cjs',
])('acceptEdits prompts before writing %s', file => {
  const result = checkWritePermissionForTool(writeTool, { file_path: join(project, file) }, permissionContext('acceptEdits'))
  expect(result.behavior).toBe('ask')
  expect(result.decisionReason?.type).toBe('safetyCheck')
})

test('acceptEdits still writes ordinary project files', () => {
  const result = checkWritePermissionForTool(writeTool, { file_path: join(project, 'src/x.ts') }, permissionContext('acceptEdits'))
  expect(result.behavior).toBe('allow')
})

test('plan mode offers the accept-edits switch only when plan was entered from default', () => {
  const offers = (ctx: ToolPermissionContext) =>
    generateSuggestions(join(project, 'x.ts'), 'write', ctx).some(s => s.type === 'setMode')
  expect(offers(permissionContext('default'))).toBe(true)
  expect(offers({ ...permissionContext('plan'), prePlanMode: 'default' })).toBe(true)
  expect(offers(permissionContext('plan'))).toBe(true)
  for (const prePlanMode of ['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk'] as const) {
    expect({ prePlanMode, offers: offers({ ...permissionContext('plan'), prePlanMode }) }).toEqual({ prePlanMode, offers: false })
  }
  expect(offers(permissionContext('acceptEdits'))).toBe(false)
})
