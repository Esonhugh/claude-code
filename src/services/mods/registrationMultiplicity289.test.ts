import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createModEnvironmentHost } from './environment.js'
import { dispatchModEvent } from './dispatch.js'
import { loadModDeclaration } from './loader.js'
import type { ModDeclaration, ModNext, ModRegistration } from './types.js'

// Direct declarations below intentionally exercise the production Worker guard
// independently of static scanner rejection. Scanner cases use actual files.
type Row = { label: string; pattern: string; matchers: readonly (string | undefined)[]; refused: boolean }
const rows: readonly Row[] = [
  { label: 'same literal twice without matcher', pattern: 'tool.call', matchers: [undefined, undefined], refused: true },
  { label: 'same all-pattern twice despite disjoint matchers', pattern: '*', matchers: ["{tool:'Bash'}", "{tool:'Read'}"], refused: true },
  { label: 'same prefix twice despite disjoint matchers', pattern: 'tool.*', matchers: ["{tool:'Bash'}", "{tool:'Read'}"], refused: true },
  { label: 'same negated literal twice despite disjoint matchers', pattern: '!tool.call', matchers: ["{tool:'Bash'}", "{tool:'Read'}"], refused: true },
  { label: 'second unmatched literal after matched registration', pattern: 'tool.call', matchers: [undefined, "{tool:'Bash'}", undefined], refused: true },
  { label: 'two matched literals', pattern: 'tool.call', matchers: ["{tool:'Bash'}", "{tool:'Read'}"], refused: false },
  { label: 'identical empty matched literals', pattern: 'tool.call', matchers: ['{}', '{}'], refused: false },
  { label: 'one unmatched before two matched literals', pattern: 'tool.call', matchers: [undefined, "{tool:'Bash'}", "{tool:'Read'}"], refused: false },
  { label: 'one unmatched after two matched literals', pattern: 'tool.call', matchers: ["{tool:'Bash'}", "{tool:'Read'}", undefined], refused: false },
]
function calls(pattern: string, matchers: readonly (string | undefined)[]): string {
  return matchers.map((matcher, index) => `on(${JSON.stringify(pattern)}, ${matcher === undefined ? '' : matcher + ', '}
    async ($, e, next) => { const below = await next(e); return {result:below.result + ':h${index}'}; });`).join('\n')
}
function moduleSource(row: Row): string {
  return `export function register(on) {\n${calls(row.pattern, row.matchers)}\n}`
}
function direct(source: string, patterns: string[]): ModDeclaration {
  return { name: 'rt7-fixture', storageId: 'rt7-fixture@local', pluginRoot: '/rt7-owned-input',
    entrypoints: ['/rt7-owned-input/register.js'], modules: [{path:'/rt7-owned-input/register.js', source}],
    links: [], events: patterns, calls: [], nextTiers: [], options: {}, tier: 'user', fingerprint: source }
}
async function actualInput(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'mods-rt7-'))
  try {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, name)), {recursive:true})
      await writeFile(join(root, name), text)
    }
    return {root, input:{name:'rt7-fixture',storageId:'rt7-fixture@local',pluginRoot:root,entrypoints:[join(root,'register.ts')]}}
  } catch (error) { await rm(root, {recursive:true,force:true}); throw error }
}
for (const row of rows) {
  test('RT7 static: ' + row.label, async () => {
    const {root,input} = await actualInput({'register.ts':moduleSource(row)})
    try {
      if (row.refused) await expect(loadModDeclaration(input)).rejects.toThrow(/registered twice/)
      else {
        const declaration = await loadModDeclaration(input)
        expect(declaration.events).toEqual([row.pattern])
        expect(declaration.validation?.registrations).toHaveLength(row.matchers.length)
      }
    } finally { await rm(root, {recursive:true,force:true}) }
  })
  test('RT7 real Worker: ' + row.label, async () => {
    const host = createModEnvironmentHost()
    try {
      const loaded = host.load(direct(moduleSource(row), [row.pattern]))
      if (row.refused) await expect(loaded).rejects.toThrow(/registered twice/)
      else {
        const environment = await loaded
        expect(environment.registrations.map(item => item.event)).toEqual(row.matchers.map(() => row.pattern))
        expect(new Set(environment.registrations.map(item => item.id)).size).toBe(row.matchers.length)
        expect(environment.registrations.map(item => item.matcher === undefined)).toEqual(row.matchers.map(item => item === undefined))
        await environment.dispose()
      }
    } finally { await host.dispose() }
  })
}
function hooks(environment: Awaited<ReturnType<ReturnType<typeof createModEnvironmentHost>['load']>>) {
  return environment.registrations.map((registration: ModRegistration) => ({
    plugin:'rt7-fixture',tier:'user' as const,registration,
    invoke:(input:Record<string,unknown>, next:ModNext) => environment.invoke(registration.id,[{},input],next),
  }))
}
test('RT7 real Worker: single broad matcher can miss; repeated broad registration still fails at load', async () => {
  const host = createModEnvironmentHost()
  try {
    const environment = await host.load(direct(moduleSource({label:'',pattern:'*',matchers:["{tool:'Bash'}"],refused:false}), ['*']))
    expect(await dispatchModEvent({event:'tool.call',input:{tool:'Write'},hooks:hooks(environment),core:async()=>({result:'core'})})).toEqual({result:'core'})
    let loadFailure: unknown
    try { await host.load(direct(moduleSource(rows[1]!), ['*'])) } catch (error) { loadFailure = error }
    expect(loadFailure).toBeInstanceOf(Error)
    expect((loadFailure as Error).message).toMatch(/registered twice/)
    expect(await dispatchModEvent({event:'tool.call',input:{tool:'Bash'},hooks:hooks(environment),core:async()=>({result:'core'})})).toEqual({result:'core:h0'})
  } finally { await host.dispose() }
})
test('RT7 raw-pattern control: overlapping distinct broad patterns both remain registered', async () => {
  const source = `export function register(on) {${calls('*',["{tool:'Bash'}"])}${calls('tool.*',["{tool:'Bash'}"])}}`
  const {root,input} = await actualInput({'register.ts':source})
  const host = createModEnvironmentHost()
  try {
    const declaration = await loadModDeclaration(input)
    expect(declaration.events).toEqual(['*','tool.*'])
    const environment = await host.load(declaration)
    expect(environment.registrations.map(item=>item.event)).toEqual(['*','tool.*'])
    expect(await dispatchModEvent({event:'tool.call',input:{tool:'Bash'},hooks:hooks(environment),core:async()=>({result:'core'})})).toEqual({result:'core:h0:h0'})
  } finally { await host.dispose(); await rm(root,{recursive:true,force:true}) }
})
test('RT7 environment lifetime: a failed load does not reserve a raw pattern in another environment', async () => {
  const host = createModEnvironmentHost()
  try {
    await expect(host.load(direct(moduleSource(rows[0]!), ['tool.call']))).rejects.toThrow(/registered twice/)
    const clean = direct(moduleSource({label:'',pattern:'tool.call',matchers:[undefined],refused:false}), ['tool.call'])
    const first = await host.load(clean)
    const second = await host.load(clean)
    expect(first.id).not.toBe(second.id)
    expect(first.registrations).toHaveLength(1); expect(second.registrations).toHaveLength(1)
    await first.dispose()
    const reloaded = await host.load(clean)
    expect(reloaded.id).not.toBe(first.id); expect(reloaded.registrations).toHaveLength(1)
  } finally { await host.dispose() }
})
test('RT7 static: one registration with catch is counted once across scanner passes', async () => {
  const {root,input} = await actualInput({'register.ts':`export function register(on) {
    on('tool.call', ($, e, next) => next(e)).catch(($, e, next) => next(e));
  }`})
  try {
    const declaration = await loadModDeclaration(input)
    expect(declaration.events).toEqual(['tool.call'])
    expect(declaration.validation?.registrations).toEqual(['tool.call'])
  } finally { await rm(root,{recursive:true,force:true}) }
})
const computedRows = [
  {pattern:'tool.call',matcher:undefined},
  {pattern:'*',matcher:"{tool:'Bash'}"},
  {pattern:'tool.*',matcher:"{tool:'Bash'}"},
  {pattern:'!tool.call',matcher:"{tool:'Bash'}"},
] as const
for (const row of computedRows) {
  const source = `export function register(on, options) {
    const pattern = options.pattern;
    on(pattern, ${row.matcher === undefined ? '' : row.matcher + ', '}($, e, next) => next(e));
    on(pattern, ${row.matcher === undefined ? '' : row.matcher + ', '}($, e, next) => next(e));
  }`
  test('RT7 computed static-refusal control: ' + row.pattern, async () => {
    const {root,input} = await actualInput({'register.ts':source})
    try { await expect(loadModDeclaration({...input,options:{pattern:row.pattern}})).rejects.toThrow(/event must be a literal pattern string/) }
    finally { await rm(root,{recursive:true,force:true}) }
  })
  test('RT7 computed real Worker guard: ' + row.pattern, async () => {
    const host = createModEnvironmentHost()
    try { await expect(host.load({...direct(source,[row.pattern]),options:{pattern:row.pattern}})).rejects.toThrow(/registered twice/) }
    finally { await host.dispose() }
  })
}
function importDeclaration(body: string, helperPattern = 'tool.call'): ModDeclaration {
  const main = '/rt7-owned-input/register.js', helper = '/rt7-owned-input/install.js'
  const source = `import { install } from './install.js'; export function register(on) {${body}}`
  const value = direct(source,[helperPattern])
  value.modules.push({path:helper,source:`export function install(on) { on(${JSON.stringify(helperPattern)}, ($, e, next) => next(e)); }`})
  value.links.push({from:main,specifier:'./install.js',to:helper})
  return value
}
for (const [label,body] of [
  ['same imported helper called twice','install(on); install(on);'],
  ['imported helper and main share on',"install(on); on('tool.call', ($, e, next) => next(e));"],
] as const) test('RT7 import real Worker guard: ' + label, async () => {
  const host = createModEnvironmentHost()
  try { await expect(host.load(importDeclaration(body))).rejects.toThrow(/registered twice/) }
  finally { await host.dispose() }
})
test('RT7 import control: actual linked helper once registers once', async () => {
  const host = createModEnvironmentHost()
  try {
    const environment = await host.load(importDeclaration('install(on);'))
    expect(environment.registrations.map(item=>item.event)).toEqual(['tool.call'])
    expect(await dispatchModEvent({event:'tool.call',input:{tool:'Write'},hooks:hooks(environment),core:async()=>({result:'core'})})).toEqual({result:'core'})
  } finally { await host.dispose() }
})
test('RT7 plugin lifetime: different plugins can claim the same pattern in one shared Worker', async () => {
  const host = createModEnvironmentHost()
  const source = moduleSource({label:'',pattern:'tool.call',matchers:[undefined],refused:false})
  try {
    const first = await host.load({...direct(source,['tool.call']),name:'rt7-first',storageId:'rt7-first@local'})
    const second = await host.load({...direct(source,['tool.call']),name:'rt7-second',storageId:'rt7-second@local'})
    expect(first.id).not.toBe(second.id)
    expect(first.registrations.map(item=>item.event)).toEqual(['tool.call'])
    expect(second.registrations.map(item=>item.event)).toEqual(['tool.call'])
  } finally { await host.dispose() }
})
