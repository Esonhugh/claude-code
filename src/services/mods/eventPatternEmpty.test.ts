import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModEnvironmentHost } from './environment.js'
import { loadModDeclaration } from './loader.js'
import { isModEventPattern } from './matcher.js'
import type { ModDeclaration } from './types.js'

// Official 2.1.292 rejects this pattern before registration multiplicity.
const reason = '"!*" is not a pattern: it selects no event; $ is always spelled $.noun.event(...) at the call site, on is always on("<event>", hook), and next.to always next.to(e, "<tier>")'
const call = 'on("!*", {}, ($, e, next) => next(e));'
const bodies = [
  ['single', `export function register(on) { ${call} }`],
  ['repeated', `export function register(on) { ${call} ${call} }`],
  ['helper', `function install(on) { ${call} } export function register(on) { install(on); }`],
] as const

test('the negation of all events is not a valid event pattern', () => {
  expect(isModEventPattern('!*')).toBe(false)
  for (const pattern of ['*', 'tool.*', '!tool.*', 'tool.call', '!tool.call'])
    expect(isModEventPattern(pattern)).toBe(true)
})

for (const [label, source] of bodies) {
  test(`scanner rejects an empty event selection: ${label}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-empty-pattern-'))
    const entry = join(root, 'register.mjs')
    try {
      await writeFile(entry, source)
      await expect(loadModDeclaration({
        name: 'empty-pattern', storageId: 'empty-pattern@inline',
        pluginRoot: root, entrypoints: [entry],
      })).rejects.toThrow(reason)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test(`Worker rejects an empty event selection: ${label}`, async () => {
    const entry = '/empty-pattern/register.mjs'
    const declaration: ModDeclaration = {
      name: 'empty-pattern', storageId: 'empty-pattern@inline',
      pluginRoot: '/empty-pattern', entrypoints: [entry],
      modules: [{ path: entry, source }], links: [], events: ['!*'],
      calls: [], nextTiers: [], options: {}, tier: 'user', fingerprint: source,
    }
    const host = createModEnvironmentHost()
    try { await expect(host.load(declaration)).rejects.toThrow(reason) }
    finally { await host.dispose() }
  })
}

for (const pattern of ['*', '!tool.call']) {
  test(`a nonempty selection still loads: ${pattern}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-nonempty-pattern-'))
    const entry = join(root, 'register.mjs')
    try {
      await writeFile(entry, `export function register(on) { on(${JSON.stringify(pattern)}, ($, e, next) => next(e)); }`)
      const declaration = await loadModDeclaration({
        name: 'nonempty-pattern', storageId: 'nonempty-pattern@inline',
        pluginRoot: root, entrypoints: [entry],
      })
      expect(declaration.events).toEqual([pattern])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

test('a helper can receive the registrar for a nonempty selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-registrar-helper-'))
  const entry = join(root, 'register.mjs')
  try {
    await writeFile(entry, 'function install(on) { on("tool.call", ($, e, next) => next(e)); } export function register(on) { install(on); }')
    const declaration = await loadModDeclaration({
      name: 'registrar-helper', storageId: 'registrar-helper@inline',
      pluginRoot: root, entrypoints: [entry],
    })
    expect(declaration.events).toEqual(['tool.call'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const body of ['unknown(on)', 'function install(value) {} install(on.foo)']) {
  test(`registrar capabilities still require a known helper and bare registrar: ${body}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-registrar-refused-'))
    const entry = join(root, 'register.mjs')
    try {
      await writeFile(entry, `export function register(on) { ${body} }`)
      await expect(loadModDeclaration({
        name: 'registrar-refused', storageId: 'registrar-refused@inline',
        pluginRoot: root, entrypoints: [entry],
      })).rejects.toThrow(/capability escape|statically traceable/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}
