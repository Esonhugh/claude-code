import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LoadedPlugin } from '../../types/plugin.js'
import {
  resolveForeignModStateDeclarations,
  validatePluginContents,
  validateMarketplaceManifest,
  validatePluginManifest,
} from './validatePlugin.js'
import { PluginMarketplaceSchema } from './schemas.js'

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
  test.each(['register.mjs', 'nested/register.mjs', '../register.mjs'])('resolves a module filename from hooks.json: %s', async modulePath => {
    const root = await pluginRoot()
    try {
      await mkdir(join(root, 'hooks', 'nested'), { recursive: true })
      await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'owner' }))
      await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify({ modules: [modulePath] }))
      await writeFile(join(root, 'hooks', modulePath), `export function register(on) { on('session.start', ($, event, next) => next(event)); }`)
      const hooks = (await validatePluginContents(root)).find(result => result.fileType === 'hooks')
      expect(hooks?.success).toBe(true)
      expect(hooks?.notes).toEqual([
        `${modulePath} hooks: session.start`,
        `${modulePath} calls: nothing on $`,
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects module paths and symlinks outside the plugin after resolving their directory', async () => {
    const root = await pluginRoot()
    const outside = await pluginRoot()
    try {
      await mkdir(join(root, 'hooks'))
      await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'owner' }))
      await writeFile(join(outside, 'register.mjs'), 'export function register(on) {}')
      await symlink(join(outside, 'register.mjs'), join(root, 'hooks', 'outside.mjs'))
      for (const [modulePath, message] of [
        [join('..', '..', basename(outside), 'register.mjs'), 'path is outside plugin root'],
        [join(outside, 'register.mjs'), 'ENOENT'],
        ['outside.mjs', 'realpath is outside plugin root'],
      ] as const) {
        await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify({ modules: [modulePath] }))
        const hooks = (await validatePluginContents(root)).find(result => result.fileType === 'hooks')
        expect(hooks?.success).toBe(false)
        expect(hooks?.errors).toHaveLength(1)
        expect(hooks?.errors[0]?.path).toBe(`modules.${modulePath}`)
        expect(hooks?.errors[0]?.message).toContain(message)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

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

  test('reads, hashes and compiles each listed .wasm file as the official build does', async () => {
    const head = [0, 97, 115, 109, 1, 0, 0, 0]
    // (func (export "answer") (result i32) i32.const 42)
    const answer = Uint8Array.from([...head, 1, 5, 1, 0x60, 0, 1, 0x7f, 3, 2, 1, 0,
      7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0, 10, 6, 1, 4, 0, 0x41, 42, 0x0b])
    // (import "env" "f" (func)) (import "env" "mem" (memory 1))
    const imports = Uint8Array.from([...head, 1, 4, 1, 0x60, 0, 0,
      2, 20, 2, 3, 101, 110, 118, 1, 102, 0, 0, 3, 101, 110, 118, 3, 109, 101, 109, 2, 0, 1])
    const root = await pluginRoot()
    try {
      await mkdir(join(root, 'hooks', 'sub'), { recursive: true })
      await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'owner' }))
      await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./m.mjs'] }))
      await writeFile(join(root, 'hooks', 'answer.wasm'), answer)
      await writeFile(join(root, 'hooks', 'sub', 'imports.wasm'), imports)
      await writeFile(join(root, 'hooks', 'garbage.wasm'), Uint8Array.from([1, 2, 3]))
      await writeFile(join(root, 'hooks', 'shared.wasm'), Uint8Array.from([...head, 5, 4, 1, 3, 1, 1]))
      const validate = async (body: string) => {
        await writeFile(join(root, 'hooks', 'm.mjs'), `export function register(on) { on('session.start', async ($) => { ${body} }) }`)
        return (await validatePluginContents(root)).find(result => result.fileType === 'hooks')!
      }
      const hash = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
      const clean = await validate(`await $.wasm.compile('./answer.wasm'); await $.wasm.compile('./sub/imports.wasm'); await $.wasm.compile(new Uint8Array(8))`)
      expect(clean.errors).toEqual([])
      expect(clean.notes).toEqual([
        './m.mjs hooks: session.start',
        './m.mjs calls: $.wasm.compile',
        `./m.mjs wasm hooks/answer.wasm: 39 bytes, sha256 ${hash(answer)}`,
        './m.mjs wasm hooks/answer.wasm imports: nothing',
        './m.mjs wasm hooks/answer.wasm exports: answer (function)',
        `./m.mjs wasm hooks/sub/imports.wasm: ${imports.length} bytes, sha256 ${hash(imports)}`,
        './m.mjs wasm hooks/sub/imports.wasm imports: env.f (function), env.mem (memory)',
        './m.mjs wasm hooks/sub/imports.wasm exports: nothing',
        './m.mjs wasm: bytes made at run time',
      ])
      const refused = await validate(`await $.wasm.compile('./garbage.wasm'); await $.wasm.compile('./shared.wasm'); await $.wasm.compile('./missing.wasm')`)
      expect(refused.errors).toEqual([
        { path: 'modules../m.mjs', message: "hooks/garbage.wasm: WebAssembly.Module doesn't parse at byte 0: expected a module of at least 8 bytes" },
        { path: 'modules../m.mjs', message: `${basename(root)}: ${join(root, 'hooks', 'missing.wasm')}: no such file` },
        { path: 'modules../m.mjs', message: `hooks/shared.wasm: ${basename(root)}: $.wasm.compile: the module declares a shared memory, which no hooks module may hold` },
      ])
      expect(refused.notes).toEqual(['./m.mjs hooks: session.start', './m.mjs calls: $.wasm.compile'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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

  test('lists what an engine.create hook in form adds and withholds, and names one outside its form', async () => {
    const root = await pluginRoot()
    await mkdir(join(root, 'hooks'))
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'owner' }))
    await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./m.mjs'] }))
    const validate = async (source: string) => {
      await writeFile(join(root, 'hooks', 'm.mjs'), source)
      return (await validatePluginContents(root)).find(result => result.fileType === 'hooks')
    }
    try {
      const inForm = await validate(`export function register(on){
  on("engine.create", async ($,e,next)=>{
    const { fs, process, ...beneath } = await next(e)
    return { ...beneath, voice: {} }
  })
}`)
      expect(inForm?.success).toBe(true)
      expect(inForm?.notes).toEqual([
        './m.mjs hooks: engine.create',
        './m.mjs calls: nothing on $',
        './m.mjs adds to $: voice',
        './m.mjs withholds from $: fs, process (in the user or builtin tier, the fold refuses this and unloads the module)',
      ])
      const outside = await validate(`export function register(on){
  on("engine.create", async ($,e,next)=>{
    const below = await next(e)
    const {ui, ...kept} = below
    return kept
  })
}`)
      expect(outside?.success).toBe(false)
      expect(outside?.errors[0]?.message).toStartWith('hooks/m.mjs:4: this engine.create hook is outside its form: a use of below other than the return')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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

  test('uses types/index.d.ts as the contract when plugin.json names no types', async () => {
    const root = await pluginRoot()
    await mkdir(join(root, 'hooks'))
    await mkdir(join(root, 'types'))
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'rg' }))
    await writeFile(join(root, 'types', 'index.d.ts'), `declare module 'claude-code' { interface PluginState { rg: { n: number } } }`)
    await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
    await writeFile(join(root, 'hooks', 'register.ts'), `export function register(on) { on('session.start', async ($) => { await $.state.set({plugin:'rg', key:'n'}, 1); }); }`)
    const manifest = await validatePluginManifest(join(root, '.claude-plugin', 'plugin.json'))
    expect(manifest.success).toBe(true)
    expect(manifest.notes).toEqual(['types ./types/index.d.ts declares state: rg.n'])
    const hooks = (await validatePluginContents(root)).find(result => result.fileType === 'hooks')!
    expect(hooks.errors).toEqual([])
    expect(hooks.success).toBe(true)
  })

  test('reads a foreign default types/index.d.ts and skips plugins without one', async () => {
    const foreign = await pluginRoot()
    const bare = await pluginRoot()
    await mkdir(join(foreign, 'types'))
    await writeFile(join(foreign, 'types', 'index.d.ts'), `declare module 'claude-code' { interface PluginState { other: { value: string } } }`)
    const resolved = await resolveForeignModStateDeclarations([
      loadedPlugin(foreign, 'other'),
      loadedPlugin(bare, 'bare'),
    ], 'owner')
    expect(resolved.warning).toBeUndefined()
    expect(resolved.declarations?.flatMap(({ plugin, keys }) => keys.map(key => `${plugin}.${key}`))).toEqual(['other.value'])
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

describe('official 2.1.318 manifest fields', () => {
  test('accepts marketplace $schema, description, renames and entry displayName', async () => {
    const root = await pluginRoot()
    await writeFile(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
      name: 'market',
      version: '1.0.0',
      description: 'A marketplace',
      owner: { name: 'owner' },
      renames: { 'old-name': 'tool', gone: null },
      plugins: [{ name: 'tool', displayName: 'Tool', source: './tool' }],
    }))
    const result = await validateMarketplaceManifest(join(root, '.claude-plugin', 'marketplace.json'))
    expect(result.errors).toEqual([])
  })

  test('warns instead of failing on a plugin source this build cannot install', async () => {
    const root = await pluginRoot()
    await writeFile(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'market',
      owner: { name: 'owner' },
      plugins: [{ name: 'packed', source: { source: 'archive', url: 'https://example.com/p.zip' } }],
    }))
    const result = await validateMarketplaceManifest(join(root, '.claude-plugin', 'marketplace.json'))
    expect(result.errors).toEqual([])
    expect(result.warnings.map(w => w.path)).toContain('plugins[0].source')
  })

  test('accepts plugin.json displayName and icon', async () => {
    const root = await pluginRoot()
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tool', displayName: 'Tool', icon: './icon.png' }))
    const result = await validatePluginManifest(join(root, '.claude-plugin', 'plugin.json'))
    expect(result.errors).toEqual([])
  })

  test('frontmatter the runtime loader recovers is not reported as unparseable', async () => {
    const root = await pluginRoot()
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tool' }))
    await mkdir(join(root, 'commands'))
    await writeFile(join(root, 'commands', 'go.md'), '---\ndescription: Start here: say what you want\nargument-hint: [system] [--source <path>]\n---\nbody\n')
    const results = await validatePluginContents(root)
    expect(results.flatMap(r => r.errors)).toEqual([])
  })
})

test('a marketplace with an entry of an unknown source type still loads its other plugins', () => {
  const marketplace = PluginMarketplaceSchema().parse({
    name: 'market',
    owner: { name: 'owner' },
    plugins: [
      { name: 'packed', source: { source: 'archive', url: 'https://example.com/p.zip' } },
      { name: 'xcode', source: { source: 'command', command: 'xcrun agent plugin path', mode: 'link' } },
      { name: 'tool', source: { source: 'github', repo: 'owner/tool' } },
    ],
  })
  expect(marketplace.plugins.map(p => p.source)).toEqual([
    { source: 'unsupported', sourceType: 'archive' },
    { source: 'command', command: 'xcrun agent plugin path', mode: 'link' },
    { source: 'github', repo: 'owner/tool' },
  ])
})

test('a marketplace with a malformed entry still loads its other plugins', () => {
  const marketplace = PluginMarketplaceSchema().parse({
    name: 'market',
    owner: { name: 'owner' },
    plugins: [
      { name: 'good', source: './good' },
      { name: 'climb', source: '../outside' },
      { name: 'abs', source: '/etc' },
      { source: './nameless' },
    ],
  })
  expect(marketplace.plugins.map(p => [p.name, p.source])).toEqual([
    ['good', './good'],
    ['climb', { source: 'unsupported', sourceType: 'invalid', error: 'source: Invalid string: must start with "./"' }],
    ['abs', { source: 'unsupported', sourceType: 'invalid', error: 'source: Invalid string: must start with "./"' }],
  ])
})

describe('UTF-8 BOM', () => {
  const BOM = '﻿'

  test('accepts plugin, marketplace and hooks files that start with a BOM', async () => {
    const root = await pluginRoot()
    const manifest = join(root, '.claude-plugin', 'plugin.json')
    await writeFile(manifest, BOM + JSON.stringify({ name: 'bom', description: 'd' }))
    const marketplace = join(root, '.claude-plugin', 'marketplace.json')
    await writeFile(marketplace, BOM + JSON.stringify({ name: 'bm', owner: { name: 'x' }, plugins: [] }))
    await mkdir(join(root, 'hooks'))
    await writeFile(join(root, 'hooks', 'hooks.json'), BOM + JSON.stringify({ hooks: {} }))

    expect((await validatePluginManifest(manifest)).errors).toEqual([])
    expect((await validateMarketplaceManifest(marketplace)).errors).toEqual([])
    const hooks = (await validatePluginContents(root)).find(result => result.fileType === 'hooks')
    expect(hooks?.errors ?? []).toEqual([])
  })
})

describe('plugin name warning', () => {
  test.each([
    ['../evil', 'refuses a plugin with this name'],
    ['My_Plugin', 'Claude Code accepts it'],
  ])('%s', async (name, text) => {
    const root = await pluginRoot()
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }))
    const result = await validatePluginManifest(join(root, '.claude-plugin', 'plugin.json'))
    expect(result.warnings.find(warning => warning.path === 'name')?.message).toContain(text)
  })
})
