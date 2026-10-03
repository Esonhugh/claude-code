import { describe, expect, test } from 'bun:test'
import { parseModTypeContract, validateModStateReferences } from './typeContract.js'

describe('Mod type contracts', () => {
  test('has no runtime imports, including the TypeScript compiler', async () => {
    const source = await Bun.file(new URL('./typeContract.ts', import.meta.url)).text()
    expect(new Bun.Transpiler({ loader: 'ts' }).scan(source).imports).toEqual([])
  })

  test('merges repeated type augmentations independently of hooks module limits', () => {
    expect(parseModTypeContract(`
      declare module 'claude-code' { interface EngineInterface { first(): void } }
      declare module 'claude-code' { interface EngineInterface { second(): void } }
    `)).toEqual({ nouns: ['first', 'second'], state: [] })
  })

  test.each([
    ['token-weather', [{ plugin: 'token-weather', keys: ['readings'] }]],
    ['blast-radius', []],
    ['replay-theater', [{ plugin: 'replay-theater', keys: ['replay', 'step'] }]],
  ] as const)('reads the unmodified %s example', async (name, state) => {
    const source = await Bun.file(new URL(`../../../examples/mods/${name}/types/index.d.ts`, import.meta.url)).text()
    expect(parseModTypeContract(source)).toEqual({ nouns: [], state: state.map(entry => ({ plugin: entry.plugin, keys: [...entry.keys] })) })
  })

  test('ignores lexical decoys and nested members, including generic commas', () => {
    expect(parseModTypeContract(`
      // declare module 'other' {} import 'bad'
      export type Text = "import('bad')" | \`interface EngineInterface { fake(): void }\`
      export type Nested<T> = Map<string, { value: T }>
      export interface Helper<T> extends Map<string, T> { helper: T }
      declare module 'claude-code' {
        /* interface EngineInterface { fake(): void } */
        interface EngineInterface {
          readonly 'quoted-noun'?: Map<string,
            Nested<{ hidden: string }>>
          run<T, U extends { nested: true }>(arg: T): U
          import(value: string): void
          12(): void
          0x10(): void
          1.5(): void
          [Symbol.iterator](): Iterator<string>
          (value: string): void
        }
        interface PluginState {
          readonly 'owner-name'?: {
            'escaped\\u002dkey': string
            nested: { notAKey: number }
            generic: Map<string,
              Nested<{ alsoNotAKey: true }>>
            method<T, U>(arg: T): U
            template: \`raw import('bad') \${string}\`
          }
          alias: Nested<string>
          union: { ignored: true } | null
          method(): { ignored: true }
          wrapped: ({ ignored: true })
        }
        interface EngineInterface { run(): void }
        interface PluginState { 'owner-name': { additional: true } }
      }
    `)).toEqual({
      nouns: ['quoted-noun', 'run', 'import', '12', '16', '1.5'],
      state: [{ plugin: 'owner-name', keys: ['escaped-key', 'nested', 'generic', 'method', 'template', 'additional'] }],
    })
  })

  test.each([
    `declare module 'claude-code' { interface EngineInterface<T> {} }`,
    `declare module 'claude-code' { interface PluginState extends Other {} }`,
    `declare module 'claude-code' { type Hidden = string }`,
    `declare module 'claude-code' { declare const hidden: string }`,
    `declare module 'claude-code' { module 'other' {} }`,
    `export type Good = string; declare const hidden: string`,
    `export type Good = string\ndeclare function hidden(): void`,
    `export type Good = string; export { Good }`,
    `interface Global { value: string }`,
    `export type Bad = ;`,
    `declare module 'claude-code' { interface EngineInterface { bad: } }`,
    'export type Bad = `text ${import("other").Value}`',
    'export type Bad = `text ${`nested ${import("other").Value}`}`',
  ])('refuses invalid syntax or augmentation: %s', source => {
    expect(() => parseModTypeContract(source)).toThrow()
  })

  test('keeps conditional type branches and punctuation-like quoted names out of boundaries', () => {
    expect(parseModTypeContract(`
      export type type = string
      export type Alias = type
      declare module 'claude-code' {
        interface EngineInterface {
          ',': string
          ';': string
          conditional: string extends string ?
            number : boolean
          next(): void
        }
        interface PluginState { owner: {
          conditional: string extends string ?
            number : boolean
          next: true
        } }
      }
    `)).toEqual({ nouns: [',', ';', 'conditional', 'next'], state: [{ plugin: 'owner', keys: ['conditional', 'next'] }] })
  })

  test('allows an empty contract and type-only exports without augmentation', () => {
    expect(parseModTypeContract('')).toEqual({ nouns: [], state: [] })
    expect(parseModTypeContract('export {}; export type Value<T> = T extends string ? { ok: T } : never'))
      .toEqual({ nouns: [], state: [] })
  })

  test('extracts EngineInterface and PluginState declarations', () => {
    expect(parseModTypeContract(`
      export type Local = { ok: true }
      declare module 'claude-code' {
        interface EngineInterface { audit(input: string): Promise<void> }
        interface PluginState {
          owner: { shared: string; optional?: number }
          reader: { value: boolean }
        }
      }
    `)).toEqual({
      nouns: ['audit'],
      state: [
        { plugin: 'owner', keys: ['shared', 'optional'] },
        { plugin: 'reader', keys: ['value'] },
      ],
    })
  })

  test.each([
    `export const runtime = 1`,
    `declare global { interface Window { value: string } }`,
    `declare module 'other' { interface Value { key: string } }`,
    `import type { Value } from './other.js'`,
    `export type Value = import('./other.js').Value; declare module 'claude-code' {}`,
    `declare module 'claude-code' { interface EngineInterface { value: import('./other.js').Value } }`,
    `/// <reference path="./other.d.ts" />\ndeclare module 'claude-code' {}`,
    `/// <reference types="node" />\ndeclare module 'claude-code' {}`,
    `/// <reference lib="dom" />\ndeclare module 'claude-code' {}`,
  ])('refuses runtime or non-self-contained declarations: %s', source => {
    expect(() => parseModTypeContract(source)).toThrow()
  })
})

describe('Mod state contract validation', () => {
  test('rejects foreign writes and missing self declarations while leaving unavailable foreign refs unchecked', () => {
    expect(validateModStateReferences({
      owner: 'owner',
      references: {
        reads: [
          { plugin: 'owner', key: 'missing' },
          { plugin: 'reader', key: 'unknown' },
        ],
        writes: [{ plugin: 'reader', key: 'value' }],
      },
      declared: [{ plugin: 'owner', keys: ['shared'] }],
    })).toEqual({
      problems: [
        '$.state.set refers to reader.value, which reader owns; only a value\'s owner may write it',
        'owner.missing is not declared in the manifest types contract',
      ],
      unchecked: ['reader.unknown', 'reader.value'],
    })
  })
})
