import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadModDeclaration, validateModRegistrations } from './loader'

const officialModsRoot = process.env.CLAUDE_CODE_OFFICIAL_MODS_FIXTURE
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function plugin(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'mods-loader-'))
  roots.push(root)
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), source)
  }
  return {
    name: 'example', storageId: 'example@local', pluginRoot: root,
    entrypoints: [join(root, 'main.ts')],
  }
}

test('loads static relative imports, cycles, and the empty claude-code namespace without running code', async () => {
  const input = await plugin({
    'main.ts': `import type { Register } from 'claude-code'
      import * as api from 'claude-code'
      import { calculate } from './lib/calc'
      throw new Error('must not execute')
      const install: Register = (listen) => {
        listen('session.start', async (host, event, resume) => {
          return resume({ value: calculate(2) })
        })
      }
      export { install as register }`,
    'lib/calc.ts': `import './cycle.js'; export const calculate = (n: number) => n * 2`,
    'lib/cycle.js': `import './calc.ts'; export const label = 'cycle'`,
  })
  const declaration = await loadModDeclaration(input)
  expect(declaration.events).toEqual(['session.start'])
  expect(declaration.calls).toEqual([])
  expect(declaration.modules.map(module => module.path).sort()).toEqual([
    input.entrypoints[0]!, join(input.pluginRoot, 'lib/calc.ts'), join(input.pluginRoot, 'lib/cycle.js'),
  ].sort())
  expect(declaration.links).toContainEqual({ from: input.entrypoints[0], specifier: 'claude-code', to: 'claude-code' })
  expect(declaration.links).toContainEqual({ from: input.entrypoints[0], specifier: './lib/calc', to: join(input.pluginRoot, 'lib/calc.ts') })
})

test('rejects top-level await in imported files, including files also used as entrypoints', async () => {
  const input = await plugin({
    'main.ts': `import './helper.ts'; export function register(on) {}`,
    'helper.ts': `await Promise.resolve(); export function register(on) {}`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow('top-level await')
  await expect(loadModDeclaration({ ...input, entrypoints: [...input.entrypoints, join(input.pluginRoot, 'helper.ts')] })).rejects.toThrow('top-level await')
})

test('tracks renamed capabilities, closures, provider function parameters, and catch handlers lexically', async () => {
  const input = await plugin({
    'main.ts': `export function register(listen) {
      listen('engine.create', async (host, input, resume) => {
        const beneath = await resume(input)
        function calculate(host) { return host + 1 }
        return { ...beneath, arithmetic: {
          add: async (left, right, third) => ({ value: calculate(left.value) + right }),
          time: async (input) => beneath.clock.now(input),
        } }
      })
      listen('session.start', async (host, input, resume) => {
        const calculate = (host, resume) => host + resume
        { const host = { tool: { register() {} } }; host.tool.register() }
        for (const host of [1]) calculate(host, 2)
        try { calculate(1, 2) } catch (host) { String(host) }
        const captured = () => host.arithmetic.add({ value: 2 })
        await captured()
        return resume(input)
      }).catch(async (capabilities, input, continuation) => {
        await capabilities.clock.sleep({ ms: 1 })
        return continuation(input)
      })
      listen('arithmetic.add', (host, input, resume) => resume(input))
    }`,
  })
  const result = await loadModDeclaration(input)
  expect(result.events).toEqual(['engine.create', 'session.start', 'arithmetic.add'])
  expect(result.calls).toEqual(['arithmetic.add', 'clock.now', 'clock.sleep'])
})

test('rejects registration handle escape that would hide catch-handler capabilities', async () => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    const handle = on('tool.call', (host, event, next) => next(event))
    handle.catch((host, event, next) => host.tool.register(event))
  }` })
  await expect(loadModDeclaration(input)).rejects.toThrow('registration')
})

test.each([
  `on('engine.create', async (host, e, next) => { const engine = await next.to(e, 'core'); return engine.tool.register(e) })`,
  `on('engine.create', async (host, e, next) => (await next(e)).tool.call(e))`,
  `on('engine.create', async (host, e, next) => { const reveal = () => below; const below = await next(e); return reveal().tool.call(e) })`,
  `on('engine.create', async (host, e, next) => { const below = await next(e); function reveal() { return below }; return reveal().tool.call(e) })`,
  `on('engine.create', async (host, e, next) => { const below = await next(e); const reveal = () => ({ ...below }); return reveal().tool.call(e) })`,
  `on('tool.call', function(host, e, next) { return arguments[0].tool.register(e) })`,
  `const extra = register; extra((name, callback) => callback({}, {}, () => ({})))`,
])('rejects untracked capability escape: %s', async body => {
  const input = await plugin({ 'main.ts': `export function register(on) { ${body} }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/unsupported|alias|escape/)
})

test.each([
  [`on(['tool.call'], () => {})`, /literal/],
  [`const event = 'tool.call'; on(event, () => {})`, /literal/],
  [`on('tool.call', (e) => true, () => {})`, /matcher/],
  [`on('tool.call', handler)`, /inline/],
  [`on?.('tool.call', () => {})`, /optional/],
  [`on('turn.step', () => {})`, /unsupported core event/],
  [`const alias = on; alias('tool.call', () => {})`, /alias/],
  [`on('session.start', ($, e, next) => $.tool.call(e))`, /unsupported core capability/],
  [`on('session.start', ($, e, next) => $.tool.register(e))`, /unsupported core capability/],
  [`on('session.start', ($, e, next) => $.http.fetch(e))`, /unsupported core capability/],
  [`on('session.start', ($, e, next) => $['clock'].now(e))`, /computed/],
  [`on('session.start', ($, e, next) => $.clock['now'](e))`, /computed/],
  [`on('session.start', ($, e, next) => $.clock?.now(e))`, /optional/],
  [`on('session.start', ($, e, next) => $.clock.now?.(e))`, /optional/],
  [`on('session.start', ($, e, next) => { const { clock } = $; clock.now(e) })`, /alias/],
  [`on('session.start', ($, e, next) => { const invoke = $.clock.now; invoke(e) })`, /alias/],
  [`on('session.start', ($, e, next) => { const helper = api => api.clock.now(e); return helper($) })`, /helpers/],
  [`on('session.start', ($, e, next) => { const alias = next; return alias(e) })`, /alias/],
  [`on('session.start', ($, e, next) => next.to(e, e.tier))`, /literal/],
  [`on('session.start', ($, e, next) => next['to'](e, 'core'))`, /literal/],
  [`on('session.start', ($, e, next) => next.to(e, 'unknown'))`, /literal/],
  [`on('engine.create', ($, e, next) => next(e)).catch(() => {})`, /engine.create catch/],
  [`on('session.start', ({ clock }, e, next) => clock.now(e))`, /parameters/],
  [`on('session.start', ($, ...args) => args[1].to(args[0], 'core'))`, /parameters/],
  [`var alias = on`, /var/],
])('rejects unsupported author syntax: %s', async (body, diagnostic) => {
  const input = await plugin({ 'main.ts': `export function register(on) { ${body} }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(diagnostic)
})

test.each([
  [`import fs from 'node:fs'; export function register(on) {}`, /bare/],
  [`import 'some-package'; export function register(on) {}`, /bare/],
  [`import '/absolute.js'; export function register(on) {}`, /bare/],
  [`import { on } from 'claude-code'; export function register(listen) {}`, /empty runtime/],
  [`export default function register(on) {}`, /named register/],
  [`export { register } from './helper.ts'`, /re-exported register/],
  [`export function register(on) { import('./helper.ts') }`, /dynamic import/],
  [`export function register(on) { if (false) import('./helper.ts') }`, /dynamic import/],
  [`export function register(on) { require('./helper.ts') }`, /unsupported/],
  [`export function register(on) { eval('1') }`, /unsupported/],
  [`export function register(on) { new Function('return 1') }`, /unsupported/],
  [`export function register(on) { return import.meta.url }`, /unsupported/],
])('rejects unsupported module syntax: %s', async (source, diagnostic) => {
  const input = await plugin({ 'main.ts': source, 'helper.ts': 'export function register(on) {}' })
  await expect(loadModDeclaration(input)).rejects.toThrow(diagnostic)
})

test.each([
  `export function register(on) { const matcher = getMatcher(); on('tool.call', { tool: matcher }, () => ({})) }`,
  `export function register(on) { let matcher = 'Bash'; on('tool.call', { tool: matcher }, () => ({})) }`,
  `export function register(on) { const matchers = getMatchers(); on('tool.call', { tool: [...matchers] }, () => ({})) }`,
])('rejects dynamic identifiers and spreads in matcher data: %s', async source => {
  const input = await plugin({ 'main.ts': source })
  await expect(loadModDeclaration(input)).rejects.toThrow(/matcher.*constant|static matcher/i)
})

test('scans official matcher forms and pattern registrations without evaluating constants', async () => {
  const input = await plugin({
    'main.ts': `import { COMMAND, TOOLS } from './constants.js'
      export function register(on) {
        on('*', { tool: /Bash|Edit/, input: { command: /^git\\s/ } }, ($, e, next) => next(e))
        on('command.*', { command: COMMAND }, ($, e, next) => next(e))
        on('!tool.call', { command: ['clear', 'resume'] }, ($, e, next) => next(e))
        on('tool.call', { tool: [...TOOLS] }, ($, e, next) => next(e))
      }`,
    'constants.ts': `export const COMMAND = 'diff'; export const TOOLS = ['Edit', 'Write'] as const`,
  })

  const result = await loadModDeclaration(input)
  expect(result.events).toEqual(['*', 'command.*', '!tool.call', 'tool.call'])
  expect(result.modules.map(module => module.path)).toContain(join(input.pluginRoot, 'constants.ts'))
})

test('resolves directories, remaps emitted extensions, and transpiles TSX through h and Fragment', async () => {
  const input = await plugin({
    'main.ts': `import { view } from './view/index.js'; import './helper.jsx'; export function register(on) { on('ui.render', ($, e, next) => next(e)); void view }`,
    'view/index.ts': `export { view } from './view.js'`,
    'view/view.tsx': `export const view = (Box: any) => <><Box>ok</Box></>`,
    'helper.tsx': `export const helper = <Text>ok</Text>`,
  })

  const result = await loadModDeclaration(input)
  expect(result.modules.map(module => module.path).sort()).toEqual([
    input.entrypoints[0], join(input.pluginRoot, 'view/index.ts'),
    join(input.pluginRoot, 'view/view.tsx'), join(input.pluginRoot, 'helper.tsx'),
  ].sort())
  expect(result.links).toContainEqual({ from: input.entrypoints[0], specifier: './view/index.js', to: join(input.pluginRoot, 'view/index.ts') })
  expect(result.links).toContainEqual({ from: join(input.pluginRoot, 'view/index.ts'), specifier: './view.js', to: join(input.pluginRoot, 'view/view.tsx') })
  expect(result.modules.find(module => module.path.endsWith('view.tsx'))?.source).toContain('h(Fragment')
  expect(result.modules.find(module => module.path.endsWith('helper.tsx'))?.source).toContain('h(Text')
})

test.skipIf(!officialModsRoot)(
  'loads the complete official diff and sec-default graphs with exact declarations',
  async () => {
    const diffRoot = join(officialModsRoot!, 'diff/hooks')
    const securityRoot = join(officialModsRoot!, 'sec-default/hooks')
    const diff = await loadModDeclaration({
      name: 'diff', storageId: 'diff@official', pluginRoot: diffRoot,
      entrypoints: [join(diffRoot, 'register.ts')],
    })
    const security = await loadModDeclaration({
      name: 'sec-default', storageId: 'sec-default@official', pluginRoot: securityRoot,
      entrypoints: [join(securityRoot, 'register.ts')],
    })

    expect(diff.modules).toHaveLength(504)
    expect(diff.events).toEqual([
      'session.start', 'ui.render', 'command.run', 'ui.close', 'ui.focus',
      'ui.scroll', 'tool.call', 'turn.complete', 'prompt.submit',
    ])
    expect(diff.calls).toEqual([
      'clock.after', 'clock.every', 'clock.now', 'command.register', 'fs.list',
      'fs.read', 'fs.stat', 'process.run', 'session.id', 'session.messages',
      'store.get', 'store.set', 'telemetry.log', 'telemetry.mark', 'ui.close',
      'ui.invalidate', 'ui.log', 'ui.open', 'ui.resolve', 'ui.status',
    ])
    expect(diff.nextTiers).toEqual([])
    expect(security.modules).toHaveLength(21)
    expect(security.events).toEqual([
      'classic.*', 'prompt.section', 'prompt.context', 'skill.prompt',
      'attribution.text', 'settings.read', 'tool.describe', 'command.describe',
      'agent.offer', 'agent.spawn', 'tool.register', 'tool.list',
    ])
    expect(security.calls).toEqual(['settings.read'])
    expect(security.nextTiers).toEqual(['append'])
  },
)

test('normalizes actual VM registrations and keeps scan consistency for every pattern', async () => {
  const input = await plugin({
    'main.ts': `export function register(on) {
      on('tool.*', { tool: /Bash/, input: { command: ['pwd', /^git/] } }, () => ({}))
    }`,
  })
  const declaration = await loadModDeclaration(input)
  const registrations = validateModRegistrations(declaration, [{
    id: 1,
    event: 'tool.*',
    matcher: { tool: /Bash/, input: { command: ['pwd', /^git/] } },
    hasCatch: false,
  }])

  expect(registrations[0]?.matcher).not.toBeUndefined()
  expect(() => validateModRegistrations(declaration, [{
    id: 1, event: 'session.*', hasCatch: false,
  }])).toThrow('absent from scan')
})

test('rejects passing the whole engine to an imported ordinary helper', async () => {
  const input = await plugin({
    'main.ts': `import { helper } from './helper.js'; export function register(on) {
      on('session.start', (host, e, next) => helper(host))
    }`,
    'helper.js': `export function helper(value) { return value.tool.register({}) }`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow('helpers')
})

test('does not approve an imported capability helper through an unrelated same-name function', async () => {
  const input = await plugin({
    'main.ts': `import { helper } from './unsafe.js'; import './safe.js'; export function register(on) {
      on('tool.describe', ($, e, next) => helper(e, next))
    }`,
    'unsafe.js': `export function helper(e, value) { return value(e) }`,
    'safe.js': `export function helper(next, e) { return next(e) }`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow('helpers')
})

test('rejects passing the whole engine to an imported capability helper', async () => {
  const input = await plugin({
    'main.ts': `import { helper } from './helper.js'; export function register(on) {
      on('session.start', ($, e, next) => helper($))
    }`,
    'helper.js': `export function helper(host) { return host.clock.now() }`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow('helpers')
})

test('scans capabilities and tiers in imported helpers that receive next', async () => {
  const input = await plugin({
    'main.ts': `import { continuePastUsers } from './helper.js'; export function register(on) {
      on('tool.describe', ($, e, next) => continuePastUsers(e, next))
    }`,
    'helper.js': `export function continuePastUsers(e, next) { return e.pass ? next(e) : next.to(e, 'append') }`,
  })
  const result = await loadModDeclaration(input)
  expect(result.events).toEqual(['tool.describe'])
  expect(result.nextTiers).toEqual(['append'])
})

test('enforces lexical and realpath containment for entrypoints and relative imports', async () => {
  const outside = await plugin({ 'main.ts': 'export function register(on) {}' })
  const input = await plugin({
    'main.ts': `import './escape.ts'; export function register(on) {}`,
    'inside.ts': 'export function register(on) {}',
  })
  await symlink(outside.entrypoints[0]!, join(input.pluginRoot, 'escape.ts'))
  await symlink(join(input.pluginRoot, 'inside.ts'), join(input.pluginRoot, 'safe.ts'))
  await expect(loadModDeclaration(input)).rejects.toThrow('realpath is outside')
  await expect(loadModDeclaration({ ...input, entrypoints: [join(input.pluginRoot, 'escape.ts')] })).rejects.toThrow('realpath is outside')
  await expect(loadModDeclaration({ ...input, entrypoints: outside.entrypoints })).rejects.toThrow('outside plugin root')
  await expect(loadModDeclaration({ ...input, entrypoints: ['inside.ts'] })).rejects.toThrow('absolute')
  expect((await loadModDeclaration({ ...input, entrypoints: [join(input.pluginRoot, 'safe.ts')] })).modules).toHaveLength(1)
  await writeFile(input.entrypoints[0]!, `import '../${outside.pluginRoot.split('/').at(-1)}/main.ts'; export function register(on) {}`)
  await expect(loadModDeclaration(input)).rejects.toThrow('outside plugin root')
  await mkdir(join(input.pluginRoot, 'directory.ts'))
  await expect(loadModDeclaration({ ...input, entrypoints: [join(input.pluginRoot, 'directory.ts')] })).rejects.toThrow('regular file')
})

test('enforces 1 MiB per file, 512 modules, and 8 MiB per graph', async () => {
  const source = 'export function register(on) {}'
  const oversized = await plugin({ 'main.ts': source + ' '.repeat(1024 * 1024) })
  await expect(loadModDeclaration(oversized)).rejects.toThrow('1 MiB')
  await writeFile(oversized.entrypoints[0]!, source.padEnd(1024 * 1024, ' '))
  expect((await loadModDeclaration(oversized)).modules).toHaveLength(1)

  const files: Record<string, string> = { 'main.ts': source }
  for (let i = 0; i < 512; i++) {
    files['main.ts'] += `;import './module-${i}.js'`
    files[`module-${i}.js`] = 'export const value = 1'
  }
  const count = await plugin(files)
  await expect(loadModDeclaration(count)).rejects.toThrow('512 files')
  await writeFile(count.entrypoints[0]!, files['main.ts']!.replace(";import './module-511.js'", ''))
  expect((await loadModDeclaration(count)).modules).toHaveLength(512)

  const large = await plugin({
    'main.ts': source + Array.from({ length: 8 }, (_, i) => `;import './large-${i}.js'`).join(''),
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`large-${i}.js`, 'export {};'.padEnd(1024 * 1024, ' ')])),
  })
  await expect(loadModDeclaration(large)).rejects.toThrow('8 MiB')
})

test('fingerprint follows snapshot content, relative graph paths, options and tier, not installation identity', async () => {
  const files = {
    'main.ts': `import { value } from './helper.js'; export function register(on) { on('session.start', ($, e, next) => next({ value })) }`,
    'helper.js': 'export const value = 1',
  }
  const first = await plugin(files)
  const second = await plugin(files)
  const options = { a: 1, nested: { b: 2, a: 3 } }
  const original = await loadModDeclaration({ ...first, options })
  const moved = await loadModDeclaration({ ...second, name: 'renamed', storageId: 'elsewhere', options: { nested: { a: 3, b: 2 }, a: 1 } })
  expect(moved.fingerprint).toBe(original.fingerprint)
  options.nested.a = 9
  expect(original.options).toEqual({ a: 1, nested: { a: 3, b: 2 } })
  expect((await loadModDeclaration({ ...first, options })).fingerprint).not.toBe(original.fingerprint)
  expect((await loadModDeclaration({ ...first, options: original.options, tier: 'append' })).fingerprint).not.toBe(original.fingerprint)
  await writeFile(join(first.pluginRoot, 'helper.js'), 'export const value = 2')
  expect(original.modules.find(module => module.path.endsWith('helper.js'))?.source).toContain('value = 1')
  expect((await loadModDeclaration({ ...first, options: original.options })).fingerprint).not.toBe(original.fingerprint)
  await writeFile(join(second.pluginRoot, 'unused.js'), 'export const value = 99')
  expect((await loadModDeclaration({ ...second, options: original.options })).fingerprint).toBe(original.fingerprint)
})

test('supports all slice events, clock methods, multiple entrypoints and async ordinary helpers', async () => {
  const input = await plugin({
    'main.ts': `import { calculate } from './helper.mjs'
      export function register(on) {
        on('engine.create', ($, e, next) => next(e))
        on('plugin.register', ($, e, next) => next(e))
        on('session.start', async ($, e, next) => {
          await calculate()
          await $.clock.now(); await $.clock.sleep(1)
          await $.clock.after(1, () => {}); await $.clock.every(1, () => {})
          return next(e)
        })
        on('clock.now', ($, e, next) => next(e))
        on('clock.sleep', ($, e, next) => next(e))
        on('clock.after', ($, e, next) => next(e))
        on('clock.every', ($, e, next) => next(e))
      }`,
    'helper.mjs': 'export async function calculate() { await Promise.resolve(); return 1 }',
    'other.mts': `export const register = on => { on('tool.call', { enabled: true, count: -1, absent: null }, ($, e, next) => next(e)) }`,
  })
  const result = await loadModDeclaration({ ...input, entrypoints: [...input.entrypoints, join(input.pluginRoot, 'other.mts')] })
  expect(result.events).toEqual(['engine.create', 'plugin.register', 'session.start', 'clock.now', 'clock.sleep', 'clock.after', 'clock.every', 'tool.call'])
  expect(result.calls).toEqual(['clock.after', 'clock.every', 'clock.now', 'clock.sleep'])
  expect(result.modules).toHaveLength(3)
})

test('fingerprint is independent of erased TS annotations and comments, but preserves entrypoint order and graph paths', async () => {
  const input = await plugin({
    'main.ts': `export function register(on: Function) { on('tool.call', () => ({ result: 1 })) }`,
    'second.ts': 'export function register(on) {}',
  })
  const original = await loadModDeclaration(input)
  await writeFile(input.entrypoints[0]!, `// comment\nexport function register(on: any) { on('tool.call', () => ({ result: 1 })) }`)
  expect((await loadModDeclaration(input)).fingerprint).toBe(original.fingerprint)
  const entries = [...input.entrypoints, join(input.pluginRoot, 'second.ts')]
  expect((await loadModDeclaration({ ...input, entrypoints: entries })).fingerprint).not.toBe((await loadModDeclaration({ ...input, entrypoints: entries.toReversed() })).fingerprint)
  await writeFile(join(input.pluginRoot, 'renamed.ts'), `export function register(on: Function) { on('tool.call', () => ({ result: 1 })) }`)
  expect((await loadModDeclaration({ ...input, entrypoints: [join(input.pluginRoot, 'renamed.ts')] })).fingerprint).not.toBe(original.fingerprint)
})

test('rejects malformed options instead of silently changing their identity', async () => {
  const input = await plugin({ 'main.ts': 'export function register(on) {}' })
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  for (const options of [{ invalid: undefined }, { invalid: Infinity }, { invalid: 1n }, { invalid: new Date() }, cyclic]) {
    await expect(loadModDeclaration({ ...input, options })).rejects.toThrow('options')
  }
})

test('checks imported source for dynamic import and for-await, not just entrypoints', async () => {
  const input = await plugin({
    'main.ts': `import './helper.js'; export function register(on) {}`,
    'helper.js': `export const run = () => import('./other.js')`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow('dynamic import')
  await writeFile(join(input.pluginRoot, 'helper.js'), 'for await (const item of []) {}')
  await expect(loadModDeclaration(input)).rejects.toThrow('top-level await')
})

test('rejects escaping directory symlinks and unsupported relative module formats', async () => {
  const outside = await plugin({ 'helper.ts': 'export const value = 1' })
  const input = await plugin({ 'main.ts': `import './linked/helper.ts'; export function register(on) {}` })
  await symlink(outside.pluginRoot, join(input.pluginRoot, 'linked'))
  await expect(loadModDeclaration(input)).rejects.toThrow('realpath is outside')
  await writeFile(input.entrypoints[0]!, `import './data.json'; export function register(on) {}`)
  await writeFile(join(input.pluginRoot, 'data.json'), '{}')
  await expect(loadModDeclaration(input)).rejects.toThrow('TS/JS ESM')
  await writeFile(input.entrypoints[0]!, `import './missing.ts'; export function register(on) {}`)
  await expect(loadModDeclaration(input)).rejects.toThrow('cannot resolve relative import')
})

test('snapshots a TS entrypoint and collects literal registrations and capabilities', async () => {
  const input = await plugin({
    'main.ts': `export function register(subscribe: Function, options: object) {
      subscribe('tool.call', { tool: 'Bash' }, async (engine, input, proceed) => {
        await engine.clock.now({})
        return proceed.to(input, 'core')
      })
    }`,
  })
  const declaration = await loadModDeclaration({ ...input, tier: 'prepend', options: { enabled: true } })
  expect(declaration.events).toEqual(['tool.call'])
  expect(declaration.calls).toEqual(['clock.now'])
  expect(declaration.nextTiers).toEqual(['core'])
  expect(declaration.modules).toHaveLength(1)
  expect(declaration.modules[0]?.path).toBe(input.entrypoints[0])
  expect(declaration.modules[0]?.source).not.toContain(': Function')
  expect(declaration.options).toEqual({ enabled: true })
  expect(declaration.tier).toBe('prepend')
  expect(declaration.fingerprint).toMatch(/^[a-f0-9]{64}$/)
})
