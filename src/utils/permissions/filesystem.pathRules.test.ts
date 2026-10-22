import { afterAll, afterEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolPermissionContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { getCwdState, getOriginalCwd, setCwdState, setOriginalCwd } = await import('../../bootstrap/state.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { getPlatform } = await import('../platform.js')
const {
  checkReadPermissionForTool,
  checkWritePermissionForTool,
  matchingRuleForInput,
  patternWithRoot,
} = await import('./filesystem.js')

const root = realpathSync(mkdtempSync(join(tmpdir(), 'fs-path-rules-')))
const project = join(root, 'project')
const outside = join(root, 'outside')
mkdirSync(join(project, 'safe'), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(outside, 'target.txt'), 'x')
// <root>/linked -> <root>/outside
symlinkSync(outside, join(root, 'linked'))
// <project>/safe/escape.txt -> <root>/outside/target.txt
symlinkSync(join(outside, 'target.txt'), join(project, 'safe', 'escape.txt'))

const savedCwd = getCwdState()
const savedOriginalCwd = getOriginalCwd()
setOriginalCwd(project)
setCwdState(project)
afterAll(() => {
  setOriginalCwd(savedOriginalCwd)
  setCwdState(savedCwd)
  rmSync(root, { recursive: true, force: true })
})
afterEach(() => {
  getPlatform.cache.clear?.()
})

function asWindows(): void {
  getPlatform.cache.set(undefined, 'windows')
}

function permissionContext(
  rules: { allow?: string[]; deny?: string[]; ask?: string[] } = {},
): ToolPermissionContext {
  return {
    ...getDefaultAppState().toolPermissionContext,
    mode: 'default',
    alwaysAllowRules: { session: rules.allow ?? [] },
    alwaysDenyRules: { session: rules.deny ?? [] },
    alwaysAskRules: { session: rules.ask ?? [] },
  } as ToolPermissionContext
}

const writeTool = {
  name: 'Write',
  getPath: (input: { file_path: string }) => input.file_path,
} as unknown as Tool
const readTool = {
  name: 'Read',
  getPath: (input: { file_path: string }) => input.file_path,
} as unknown as Tool

test('repeated slashes inside a // rule are collapsed', () => {
  const ctx = permissionContext({ deny: [`Edit(/${root}//outside//**)`] })
  expect(matchingRuleForInput(join(outside, 'target.txt'), ctx, 'edit', 'deny')).not.toBeNull()
})

test('deny and ask rules written on a symlinked directory apply to its real location', () => {
  for (const behavior of ['deny', 'ask'] as const) {
    const ctx = permissionContext({ [behavior]: [`Edit(/${join(root, 'linked')}/**)`] })
    expect(matchingRuleForInput(join(outside, 'target.txt'), ctx, 'edit', behavior)).not.toBeNull()
    expect(matchingRuleForInput(join(root, 'linked', 'target.txt'), ctx, 'edit', behavior)).not.toBeNull()
  }
})

test('an allow rule does not reach through a symlink to a target it does not cover', () => {
  const ctx = permissionContext({ allow: [`Edit(/${join(project, 'safe')}/**)`] })
  const escaped = checkWritePermissionForTool(
    writeTool,
    { file_path: join(project, 'safe', 'escape.txt') },
    ctx,
  )
  expect(escaped.behavior).toBe('ask')
  const plain = checkWritePermissionForTool(
    writeTool,
    { file_path: join(project, 'safe', 'plain.txt') },
    ctx,
  )
  expect(plain.behavior).toBe('allow')
  // The link's target is outside the working directory, so only the allow
  // rule could grant the read.
  const read = checkReadPermissionForTool(
    readTool,
    { file_path: join(project, 'safe', 'escape.txt') },
    permissionContext({ allow: [`Read(/${join(project, 'safe')}/**)`] }),
  )
  expect(read.behavior).toBe('ask')
})

test.skipIf(realpathSync('/bin') !== '/usr/bin')(
  'an allow rule on a system symlink spelling still covers the resolved file',
  () => {
    const ctx = permissionContext({ allow: ['Read(//bin/**)'] })
    const result = checkReadPermissionForTool(readTool, { file_path: '/bin/sh' }, ctx)
    expect(result.behavior).toBe('allow')
  },
)

// The Linux test host cannot resolve real Windows or UNC paths (expandPath and
// realpath are POSIX here), so the Windows cases check how a rule is split into
// its root and anchored pattern; matching then runs relative to that root.
test('Windows: //c/ rules stay anchored at the drive root', () => {
  asWindows()
  expect(patternWithRoot('//c/build/**', 'session')).toEqual({
    root: 'C:\\',
    relativePattern: '/build/**',
  })
  expect(patternWithRoot('//c/out', 'session')).toEqual({
    root: 'C:\\',
    relativePattern: '/out',
  })
})

test('Windows: drive-letter rules are rooted at the drive whatever case or slash they use', () => {
  asWindows()
  for (const rule of ['C:\\Users\\me\\secret\\**', 'c:/Users/me/secret/**', '//C/Users/me/secret/**']) {
    expect(patternWithRoot(rule, 'session')).toEqual({
      root: 'C:\\',
      relativePattern: '/Users/me/secret/**',
    })
  }
})

test('Windows: ~\\ and \\ rules use forward slashes', () => {
  asWindows()
  expect(patternWithRoot('~\\.ssh\\**', 'session')).toEqual({
    root: homedir().normalize('NFC'),
    relativePattern: '/.ssh/**',
  })
  expect(patternWithRoot('\\secrets\\**', 'session').relativePattern).toBe('/secrets/**')
})

test('Windows: a //server/share rule stays rooted at / for the UNC spelling', () => {
  asWindows()
  expect(patternWithRoot('//server/share/**', 'session')).toEqual({
    root: '/',
    relativePattern: '/server/share/**',
  })
})
