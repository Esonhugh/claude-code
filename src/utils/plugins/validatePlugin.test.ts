import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LoadedPlugin } from '../../types/plugin.js'
import {
  resolveForeignModStateDeclarations,
  validatePluginContents,
  validatePluginManifest,
} from './validatePlugin.js'

const evidenceRoot = tmpdir()

async function pluginRoot(): Promise<string> {
  await mkdir(evidenceRoot, { recursive: true })
  const root = await mkdtemp(join(evidenceRoot, 'plugin-validator-'))
  await mkdir(join(root, '.claude-plugin'))
  return root
}

function loadedPlugin(
  root: string,
  name: string,
  types?: string,
): LoadedPlugin {
  return {
    name,
    path: root,
    source: `${name}@test`,
    repository: 'test',
    enabled: true,
    manifest: { name, ...(types ? { types } : {}) },
  }
}

describe('plugin types validation', () => {
  test('retains and validates a types-only contract', async () => {
    const root = await pluginRoot()
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'owner', types: './contract.d.ts' }))
    await writeFile(join(root, 'contract.d.ts'), `declare module 'claude-code' { interface EngineInterface { audit(): void } }`)
    const result = await validatePluginManifest(join(root, '.claude-plugin', 'plugin.json'))
    expect(result.success).toBe(true)
    expect(result.notes).toEqual(['types ./contract.d.ts declares on $: $.audit'])
  })

  test.each([
    ['runtime.ts', `export const value = 1`],
    ['external.ts', `import type { Value } from './missing.ts'; declare module 'claude-code' {}`],
    ['syntax.ts', `declare module 'claude-code' { interface PluginState {`],
    ['reference.ts', `/// <reference path="./missing.d.ts" />\ndeclare module 'claude-code' {}`],
    ['import-type.ts', `export type Value = import('./missing.js').Value; declare module 'claude-code' {}`],
  ])('rejects invalid contract %s through manifest validation', async (file, source) => {
    const root = await pluginRoot()
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'owner', types: `./${file}` }))
    await writeFile(join(root, file), source)
    const result = await validatePluginManifest(join(root, '.claude-plugin', 'plugin.json'))
    expect(result.success).toBe(false)
    expect(result.errors.some(error => error.path === 'types')).toBe(true)
  })

  test('rejects a missing contract through manifest validation', async () => {
    const root = await pluginRoot()
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'owner', types: './missing.ts' }))
    const result = await validatePluginManifest(join(root, '.claude-plugin', 'plugin.json'))
    expect(result.success).toBe(false)
    expect(result.errors.some(error => error.path === 'types')).toBe(true)
  })

  test('rejects a types path whose realpath escapes the plugin root', async () => {
    const root = await pluginRoot()
    const outside = await pluginRoot()
    await writeFile(join(outside, 'contract.d.ts'), `declare module 'claude-code' {}`)
    await symlink(join(outside, 'contract.d.ts'), join(root, 'contract.d.ts'))
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'owner', types: './contract.d.ts' }))
    const result = await validatePluginManifest(join(root, '.claude-plugin', 'plugin.json'))
    expect(result.success).toBe(false)
    expect(result.errors.some(error => /realpath.*outside|resolves outside/.test(error.message))).toBe(true)
  })
})

describe('hooks module author validation', () => {
  test('reports discovered hooks, calls and state without hiding clean modules', async () => {
    const root = await pluginRoot()
    await mkdir(join(root, 'hooks'))
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'owner', types: './contract.d.ts' }))
    await writeFile(join(root, 'contract.d.ts'), `declare module 'claude-code' { interface PluginState { owner: { shared: string } } }`)
    await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
    await writeFile(join(root, 'hooks', 'register.ts'), `export function register(on) { on('session.start', async ($) => { await $.state.set({plugin:'owner', key:'shared'}, 'value'); await $.state.get({plugin:'owner', key:'shared'}); }); }`)
    const hooks = (await validatePluginContents(root)).find(result => result.fileType === 'hooks')
    expect(hooks?.success).toBe(true)
    expect(hooks?.notes).toEqual([
      './register.ts hooks: session.start',
      './register.ts calls: $.state.get, $.state.set',
      './register.ts state writes: owner.shared',
      './register.ts state reads: owner.shared',
    ])
  })

  test('reports empty registrations and calls honestly', async () => {
    const root = await pluginRoot()
    await mkdir(join(root, 'hooks'))
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'owner' }))
    await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
    await writeFile(join(root, 'hooks', 'register.ts'), 'export function register(on) {}')
    const hooks = (await validatePluginContents(root)).find(result => result.fileType === 'hooks')
    expect(hooks?.success).toBe(true)
    expect(hooks?.notes).toEqual([
      './register.ts hooks: nothing',
      './register.ts calls: nothing on $',
    ])
  })

  test('rejects a second hooks module before loading either entrypoint', async () => {
    const root = await pluginRoot()
    await mkdir(join(root, 'hooks'))
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'owner' }))
    await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./first.ts', './second.ts'] }))
    for (const file of ['first.ts', 'second.ts'])
      await writeFile(join(root, 'hooks', file), 'export function register(on) {}')
    const results = await validatePluginContents(root)
    const hooks = results.find(result => result.fileType === 'hooks')
    expect(hooks?.success).toBe(false)
    expect(hooks?.errors.some(error => error.path === 'modules')).toBe(true)
  })

  test('checks state ownership and declarations and reports unavailable foreign contracts as unchecked', async () => {
    const root = await pluginRoot()
    await mkdir(join(root, 'hooks'))
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'owner', types: './contract.d.ts' }))
    await writeFile(join(root, 'contract.d.ts'), `declare module 'claude-code' { interface PluginState { owner: { shared: string } } }`)
    await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
    await writeFile(join(root, 'hooks', 'register.ts'), `export function register(on) { on('tool.call', async ($) => { await $.state.get({plugin:'other', key:'value'}); await $.state.set({plugin:'other', key:'value'}, 1); await $.state.get({plugin:'owner', key:'missing'}); }); }`)
    const results = await validatePluginContents(root)
    const hooks = results.find(result => result.fileType === 'hooks')!
    expect(hooks.success).toBe(false)
    expect(hooks.errors.some(error => /only a value's owner may write/.test(error.message))).toBe(true)
    expect(hooks.errors.some(error => /owner\.missing.*not declared/.test(error.message))).toBe(true)
    expect(hooks.notes?.some(note => /not checked.*other\.value/.test(note))).toBe(true)
  })

  test('checks matched and missing foreign state against a complete contract context', async () => {
    const owner = await pluginRoot()
    const foreign = await pluginRoot()
    await mkdir(join(owner, 'hooks'))
    await writeFile(join(owner, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'owner' }))
    await writeFile(join(owner, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
    await writeFile(join(owner, 'hooks', 'register.ts'), `export function register(on) { on('tool.call', async ($) => { await $.state.get({plugin:'other', key:'value'}); await $.state.get({plugin:'other', key:'missing'}); }); }`)
    await writeFile(join(foreign, 'contract.d.ts'), `declare module 'claude-code' { interface PluginState { other: { value: string } } }`)
    const resolved = await resolveForeignModStateDeclarations([
      loadedPlugin(foreign, 'other', './contract.d.ts'),
    ], 'owner')
    expect(resolved.warning).toBeUndefined()
    const hooks = (await validatePluginContents(owner, resolved.declarations)).find(result => result.fileType === 'hooks')!
    expect(hooks.errors.some(error => /other\.missing.*not declared in any available/.test(error.message))).toBe(true)
    expect(hooks.errors.some(error => /other\.value/.test(error.message))).toBe(false)
    expect(hooks.notes?.some(note => /not checked/.test(note))).toBe(false)
  })

  test('treats an empty foreign contract context as complete', async () => {
    const root = await pluginRoot()
    await mkdir(join(root, 'hooks'))
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'owner' }))
    await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
    await writeFile(join(root, 'hooks', 'register.ts'), `export function register(on) { on('tool.call', async ($) => { await $.state.get({plugin:'other', key:'value'}); }); }`)
    const hooks = (await validatePluginContents(root, [])).find(result => result.fileType === 'hooks')!
    expect(hooks.errors.some(error => /other\.value.*not declared in any available/.test(error.message))).toBe(true)
    expect(hooks.notes?.some(note => /not checked/.test(note))).toBe(false)
  })

  test('does not let a same-name loaded contract fill missing owner declarations', async () => {
    const owner = await pluginRoot()
    const stale = await pluginRoot()
    await mkdir(join(owner, 'hooks'))
    await writeFile(join(owner, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'owner' }))
    await writeFile(join(owner, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
    await writeFile(join(owner, 'hooks', 'register.ts'), `export function register(on) { on('tool.call', async ($) => { await $.state.get({plugin:'owner', key:'missing'}); }); }`)
    await writeFile(join(stale, 'contract.d.ts'), `declare module 'claude-code' { interface PluginState { owner: { missing: string } } }`)
    const resolved = await resolveForeignModStateDeclarations([
      loadedPlugin(stale, 'owner', './contract.d.ts'),
    ], 'owner')
    expect(resolved.declarations).toEqual([])
    const hooks = (await validatePluginContents(owner, resolved.declarations)).find(result => result.fileType === 'hooks')!
    expect(hooks.errors.some(error => /owner\.missing.*not declared/.test(error.message))).toBe(true)
  })

  test('rejects foreign writes even when their contract is available', async () => {
    const owner = await pluginRoot()
    const foreign = await pluginRoot()
    await mkdir(join(owner, 'hooks'))
    await writeFile(join(owner, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'owner' }))
    await writeFile(join(owner, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
    await writeFile(join(owner, 'hooks', 'register.ts'), `export function register(on) { on('tool.call', async ($) => { await $.state.set({plugin:'other', key:'value'}, 1); }); }`)
    await writeFile(join(foreign, 'contract.d.ts'), `declare module 'claude-code' { interface PluginState { other: { value: string } } }`)
    const resolved = await resolveForeignModStateDeclarations([
      loadedPlugin(foreign, 'other', './contract.d.ts'),
    ], 'owner')
    const hooks = (await validatePluginContents(owner, resolved.declarations)).find(result => result.fileType === 'hooks')!
    expect(hooks.errors.some(error => /only a value's owner may write/.test(error.message))).toBe(true)
  })

  test('accepts only each loaded plugin own namespace and makes any load failure unavailable', async () => {
    const valid = await pluginRoot()
    const invalid = await pluginRoot()
    await writeFile(join(valid, 'contract.d.ts'), `declare module 'claude-code' { interface PluginState { valid: { own: string }; injected: { key: string } } }`)
    const namespaceMismatch = await resolveForeignModStateDeclarations([
      loadedPlugin(valid, 'valid', './contract.d.ts'),
    ], 'owner')
    expect(namespaceMismatch.declarations).toEqual([{ plugin: 'valid', keys: ['own'] }])

    const unavailable = await resolveForeignModStateDeclarations([
      loadedPlugin(valid, 'valid', './contract.d.ts'),
      loadedPlugin(invalid, 'broken', './missing.d.ts'),
    ], 'owner')
    expect(unavailable.declarations).toBeUndefined()
    expect(unavailable.warning).toMatch(/broken.*missing\.d\.ts.*unchecked/i)
  })
})
