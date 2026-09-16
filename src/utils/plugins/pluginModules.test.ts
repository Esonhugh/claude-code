import { describe, expect, test } from 'bun:test'
import { PluginHooksSchema } from './schemas.js'

describe('plugin module declarations', () => {
  test('retains modules-only declarations', () => {
    expect(PluginHooksSchema().parse({ modules: ['./register.ts'] })).toEqual({ modules: ['./register.ts'] })
  })
  test('keeps classic hooks and module declarations together', () => {
    const input = { hooks: {}, modules: ['./register.ts'] }
    expect(PluginHooksSchema().parse(input)).toEqual(input)
    expect(PluginHooksSchema().parse({ hooks: {} })).toEqual({ hooks: {} })
  })
  test('rejects an empty declaration and non-relative module paths', () => {
    expect(PluginHooksSchema().safeParse({}).success).toBe(false)
    expect(PluginHooksSchema().safeParse({ modules: ['/outside.ts'] }).success).toBe(false)
    expect(PluginHooksSchema().safeParse({ modules: ['node:fs'] }).success).toBe(false)
  })
})
