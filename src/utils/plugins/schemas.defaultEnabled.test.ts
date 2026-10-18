import { expect, test } from 'bun:test'
import { PluginManifestSchema } from './schemas.js'

test('plugin.json keeps defaultEnabled and strict validation accepts it', () => {
  const manifest = { name: 'demo', defaultEnabled: false }
  expect(PluginManifestSchema().parse(manifest).defaultEnabled).toBe(false)
  expect(PluginManifestSchema().strict().safeParse(manifest).success).toBe(true)
  expect(
    PluginManifestSchema().safeParse({ name: 'demo', defaultEnabled: 'no' })
      .success,
  ).toBe(false)
})
