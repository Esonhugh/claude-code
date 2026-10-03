import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import figures from 'figures'
import { plural } from '../../utils/stringUtils.js'
import { basename, dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { LoadedPlugin, PluginLoadResult } from '../../types/plugin.js'
import * as pluginLoader from '../../utils/plugins/pluginLoader.js'
import { resolveForeignModStateDeclarations, validateManifest, validatePluginContents, type ValidationResult } from '../../utils/plugins/validatePlugin.js'
import { pluginValidateHandler } from './plugins.js'

// Execute the actual printer without importing unrelated marketplace services.
const source = ts.createSourceFile(
  'plugins.ts',
  readFileSync(new URL('./plugins.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
)
function compileFunction(name: string): string {
  const declaration = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  )!
  return ts.transpileModule(declaration.getText(source).replace(/^export\s+/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText
}

const compiled = compileFunction('printValidationResult')
const evidenceRoot = tmpdir()

async function pluginRoot(name: string): Promise<string> {
  await mkdir(evidenceRoot, { recursive: true })
  const root = await mkdtemp(join(evidenceRoot, `plugin-handler-${name}-`))
  await mkdir(join(root, '.claude-plugin'))
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }))
  return root
}

function loadedPlugin(root: string, name: string, types?: string): LoadedPlugin {
  return {
    name,
    path: root,
    source: `${name}@test`,
    repository: 'test',
    enabled: true,
    manifest: { name, ...(types ? { types } : {}) },
  }
}

async function runValidate(root: string): Promise<string> {
  const lines: string[] = []
  const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => lines.push(args.join(' ')))
  const error = spyOn(console, 'error').mockImplementation((...args: unknown[]) => lines.push(args.join(' ')))
  const write = spyOn(process.stdout, 'write').mockImplementation(((value: string) => {
    lines.push(value)
    return true
  }) as never)
  try {
    await pluginValidateHandler(root, {})
  } finally {
    exit.mockRestore()
    log.mockRestore()
    error.mockRestore()
    write.mockRestore()
  }
  return lines.join('\n')
}

afterEach(() => {
  pluginLoader.loadAllPluginsCacheOnly.cache?.clear?.()
})

function print(result: ValidationResult): string {
  const lines: string[] = []
  const run = new Function('console', 'figures', 'plural', `${compiled}\nreturn printValidationResult`)(
    { log: (line: string) => lines.push(line) }, figures, plural,
  ) as (result: ValidationResult) => void
  run(result)
  return lines.join('\n')
}

test('prints author notes even when there are no errors or warnings', () => {
  const notes = [
    'types ./contract.d.ts declares on $: $.audit',
    './register.ts hooks: session.start',
    './register.ts calls: $.state.get',
    './register.ts state writes: nothing',
    './register.ts state reads: owner.shared',
  ]
  const output = print({ success: true, errors: [], warnings: [], notes, filePath: '/plugin', fileType: 'hooks' })
  for (const note of notes) expect(output).toContain(note)
  expect(output).not.toContain('error')
  expect(output).not.toContain('warning')
})

test.each(['token-weather', 'blast-radius', 'replay-theater'])(
  'prints real author diagnostics for unchanged %s', async name => {
    const root = fileURLToPath(new URL(`../../../examples/mods/${name}/`, import.meta.url))
    const manifest = await validateManifest(root)
    const contents = await validatePluginContents(root)
    expect(manifest.success).toBe(true)
    expect(contents.every(result => result.success)).toBe(true)
    const output = [manifest, ...contents].map(print).join('\n')
    expect(output).toContain('types ./types/index.d.ts declares on $:')
    expect(output).toContain(`${name}.mjs hooks:`)
    expect(output).toContain(`${name}.mjs calls:`)
    if (name === 'blast-radius') {
      expect(output).not.toContain('state writes:')
      expect(output).not.toContain('state reads:')
    } else {
      expect(output).toContain(`${name}.mjs state writes:`)
      expect(output).toContain(`${name}.mjs state reads:`)
    }
    if (name === 'token-weather') {
      expect(output).toContain('session.start, turn.complete, ui.render')
      expect(output).toContain('$.session.usage, $.state.get, $.state.set, $.ui.resolve')
      expect(output).toContain('state writes: token-weather.readings')
      expect(output).toContain('state reads: token-weather.readings')
    }
  },
)

test('keeps errors and warnings alongside notes and accepts absent notes', () => {
  const result: ValidationResult = {
    success: false, errors: [{ path: 'modules[0]', message: 'invalid state' }],
    warnings: [{ path: 'name', message: 'not kebab-case' }],
    notes: ['foreign state not checked'], filePath: '/plugin', fileType: 'hooks',
  }
  const output = print(result)
  expect(output).toContain('modules[0]: invalid state')
  expect(output).toContain('name: not kebab-case')
  expect(output).toContain('foreign state not checked')
  expect(print({ ...result, notes: undefined })).not.toContain('undefined')
})

test.each(['complete', 'complete-missing', 'empty', 'incomplete', 'incomplete-empty', 'throw', 'broken-types', 'foreign-write'])(
  'standalone validate consumes only complete contract discovery: %s', async mode => {
    const owner = await pluginRoot('owner')
    const foreign = await pluginRoot('other')
    await mkdir(join(owner, 'hooks'))
    await writeFile(join(owner, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
    await writeFile(join(owner, 'hooks', 'register.ts'), `throw new Error('must never execute'); export function register(on) { on('tool.call', async ($) => { await $.state.${mode === 'foreign-write' ? 'set' : 'get'}({plugin:'other', key:'value'}${mode === 'foreign-write' ? ', 1' : ''}); }); }`)
    await writeFile(join(foreign, 'contract.d.ts'), `declare module 'claude-code' { interface PluginState { other: { ${mode === 'complete-missing' ? 'different' : 'value'}: string } } }`)
    const lines: string[] = []
    const exits: number[] = []
    let discoveries = 0
    const forbidden = () => { throw new Error('materializing loader forbidden') }
    const bindings = {
      validateManifest, validatePluginContents, resolveForeignModStateDeclarations,
      dirname, basename, plural, figures,
      readFile: async (path: string) => readFileSync(path, 'utf8'),
      jsonParse: JSON.parse,
      errorMessage: (error: unknown) => String(error),
      getPluginErrorMessage: (error: { error?: string }) => error.error,
      logError: forbidden, setUseCoworkPlugins: forbidden,
      loadAllPlugins: forbidden, loadAllPluginsCacheOnly: forbidden,
      loadPluginsForContractValidation: async () => {
        discoveries++
        if (mode === 'throw') throw new Error('unreadable context')
        return {
          complete: !mode.startsWith('incomplete'),
          enabled: ['empty', 'incomplete-empty'].includes(mode) ? [] : [loadedPlugin(foreign, 'other', mode === 'broken-types' ? './missing.d.ts' : './contract.d.ts')],
          errors: mode === 'incomplete' ? [{ type: 'generic-error', source: 'builtin', error: 'builtin unavailable' }] : [],
        }
      },
      printValidationResult: (result: ValidationResult) => lines.push(print(result)),
      console: { log: (...args: unknown[]) => lines.push(args.join(' ')), error: forbidden },
      process: { exit: (code: number) => exits.push(code) },
      cliOk: (message: string) => { lines.push(message); exits.push(0) },
    }
    const run = new Function(...Object.keys(bindings), `${compileFunction('pluginValidateHandler')}\nreturn pluginValidateHandler`)(...Object.values(bindings)) as typeof pluginValidateHandler
    await run(owner, {})
    expect(discoveries).toBe(1)
    const output = lines.join('\n')
    if (['incomplete', 'incomplete-empty', 'throw', 'broken-types'].includes(mode)) {
      expect(output).toMatch(/not checked.*other\.value/)
      expect(output).toContain('Validation passed with warnings')
      expect(output).not.toContain('not declared in any available')
      expect(output).toContain(mode === 'incomplete' ? 'builtin unavailable' : mode === 'incomplete-empty' ? 'is incomplete' : mode === 'throw' ? 'unreadable context' : 'missing.d.ts')
      expect(exits).toEqual([0])
    } else if (mode === 'empty' || mode === 'complete-missing') {
      expect(output).toMatch(/other\.value.*not declared in any available/)
      expect(exits).toEqual([1])
    } else if (mode === 'foreign-write') {
      expect(output).toContain("only a value's owner may write")
      expect(exits).toEqual([1])
    } else {
      expect(output).not.toContain('not checked')
      expect(exits).toEqual([0])
    }
  },
)

test.each([true, false])('shared merge retains managed enabled=%s against an inline override', async enabled => {
  const installed = loadedPlugin(await pluginRoot('other'), 'other')
  installed.enabled = enabled
  const inline = loadedPlugin(await pluginRoot('other'), 'other')
  inline.source = 'other@inline'
  const result = pluginLoader.mergePluginSources({
    marketplace: [installed], session: [inline], builtin: [],
    managedNames: new Set(['other']),
  })
  expect(result.plugins).toEqual([installed])
  expect(result.plugins[0]?.enabled).toBe(enabled)
  expect(result.errors).toHaveLength(1)
  expect(result.errors[0]?.source).toBe('other@inline')
})

test('cold real handler discovers builtin contracts without invoking runtime loaders', async () => {
  const owner = await pluginRoot('owner')
  await mkdir(join(owner, 'hooks'))
  await writeFile(join(owner, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
  await writeFile(join(owner, 'hooks', 'register.ts'), `throw new Error('must never execute'); export function register(on) { on('tool.call', async ($) => { await $.state.get({plugin:'other', key:'value'}); }); }`)
  const full = spyOn(pluginLoader, 'loadAllPlugins')
  const cached = spyOn(pluginLoader, 'loadAllPluginsCacheOnly')
  try {
    const output = await runValidate(owner)
    expect(full).not.toHaveBeenCalled()
    expect(cached).not.toHaveBeenCalled()
    expect(output).not.toMatch(/incomplete/i)
    expect(output).not.toContain('not checked')
    expect(output).toMatch(/other\.value.*not declared in any available/)
  } finally {
    full.mockRestore()
    cached.mockRestore()
  }
})

test('plugin validate uses complete cached contracts for foreign state', async () => {
  const owner = await pluginRoot('owner')
  const foreign = await pluginRoot('other')
  await mkdir(join(owner, 'hooks'))
  await writeFile(join(owner, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
  await writeFile(join(owner, 'hooks', 'register.ts'), `export function register(on) { on('tool.call', async ($) => { await $.state.get({plugin:'other', key:'value'}); }); }`)
  await writeFile(join(foreign, 'contract.d.ts'), `declare module 'claude-code' { interface PluginState { other: { value: string } } }`)
  const cached: PluginLoadResult = {
    enabled: [loadedPlugin(foreign, 'other', './contract.d.ts')],
    disabled: [],
    errors: [],
  }
  pluginLoader.loadAllPluginsCacheOnly.cache?.set(undefined, Promise.resolve(cached))
  const output = await runValidate(owner)
  expect(output).not.toContain('not checked')
  expect(output).not.toContain('not declared in any available')
  expect(output).toContain('Validation passed')
})

test('plugin validate treats an empty successful cache as a complete context', async () => {
  const owner = await pluginRoot('owner')
  await mkdir(join(owner, 'hooks'))
  await writeFile(join(owner, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
  await writeFile(join(owner, 'hooks', 'register.ts'), `export function register(on) { on('tool.call', async ($) => { await $.state.get({plugin:'other', key:'value'}); }); }`)
  pluginLoader.loadAllPluginsCacheOnly.cache?.set(undefined, Promise.resolve({
    enabled: [],
    disabled: [],
    errors: [],
  }))
  const output = await runValidate(owner)
  expect(output).toMatch(/other\.value.*not declared in any available/)
  expect(output).not.toContain('not checked')
})

test('plugin validate warns and leaves foreign state unchecked for cached loader errors', async () => {
  const owner = await pluginRoot('owner')
  await mkdir(join(owner, 'hooks'))
  await writeFile(join(owner, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
  await writeFile(join(owner, 'hooks', 'register.ts'), `export function register(on) { on('tool.call', async ($) => { await $.state.get({plugin:'other', key:'value'}); }); }`)
  pluginLoader.loadAllPluginsCacheOnly.cache?.set(undefined, Promise.resolve({
    enabled: [],
    disabled: [],
    errors: [{ type: 'generic-error', source: 'broken@test', error: 'broken contract' }],
  }))
  const output = await runValidate(owner)
  expect(output).toMatch(/cached plugin context has 1 loader error.*unchecked/i)
  expect(output).toMatch(/not checked.*other\.value/)
})

test('plugin validate warns and leaves foreign state unchecked for damaged cached context', async () => {
  const owner = await pluginRoot('owner')
  const foreign = await pluginRoot('other')
  await mkdir(join(owner, 'hooks'))
  await writeFile(join(owner, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
  await writeFile(join(owner, 'hooks', 'register.ts'), `export function register(on) { on('tool.call', async ($) => { await $.state.get({plugin:'other', key:'value'}); }); }`)
  const cached: PluginLoadResult = {
    enabled: [loadedPlugin(foreign, 'other', './missing.d.ts')],
    disabled: [],
    errors: [],
  }
  pluginLoader.loadAllPluginsCacheOnly.cache?.set(undefined, Promise.resolve(cached))
  const output = await runValidate(owner)
  expect(output).toMatch(/warning/i)
  expect(output).toMatch(/missing\.d\.ts.*unchecked/i)
  expect(output).toMatch(/not checked.*other\.value/)
})

test('prints plugin tests in the official bun-style stdout contract', () => {
  const lines: string[] = []
  const run = new Function(
    'process', 'relative', 'basename',
    `${compileFunction('printPluginTestResult')}\nreturn printPluginTestResult`,
  )({ stdout: { write: (value: string) => lines.push(value) } }, relative, basename) as (root: string, result: unknown) => void
  run('/plugin', {
    durationMs: 420,
    passed: 2,
    failed: 1,
    files: [{
      file: '/plugin/tests/weather.test.ts',
      tests: [
        { name: 'weather > clear', durationMs: 12.34 },
        { name: 'weather > storm', durationMs: 5.6, failure: 'Expected Clear\nReceived Storm' },
        { name: 'weather > showers', durationMs: 0 },
      ],
    }],
  })
  expect(lines.join('')).toBe(`\ntests/weather.test.ts:\n(pass) weather > clear [12.34ms]\n(fail) weather > storm [5.60ms]\nExpected Clear\nReceived Storm\n(pass) weather > showers [0.00ms]\n\n 2 pass\n 1 fail\nRan 3 tests across 1 file. [0.42s]\n`)
})

test('prints file loading errors separately and pluralizes summary nouns', () => {
  const lines: string[] = []
  const run = new Function(
    'process', 'relative', 'basename',
    `${compileFunction('printPluginTestResult')}\nreturn printPluginTestResult`,
  )({ stdout: { write: (value: string) => lines.push(value) } }, relative, basename) as (root: string, result: unknown) => void
  run('/plugin', {
    durationMs: 1500,
    passed: 0,
    failed: 1,
    files: [
      { file: '/plugin/one.test.ts', tests: [], loadFailure: 'SyntaxError: broken' },
      { file: '/plugin/two.test.ts', tests: [] },
    ],
  })
  expect(lines.join('')).toBe(`\none.test.ts:\n(fail) the file did not load\nSyntaxError: broken\n\ntwo.test.ts:\n\n 0 pass\n 1 fail\nRan 0 tests across 2 files. [1.50s]\n`)
})
