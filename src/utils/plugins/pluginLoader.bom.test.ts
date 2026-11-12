import { expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPluginManifest } from './pluginLoader.js'

test('loads a plugin.json that starts with a UTF-8 BOM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-bom-'))
  const manifestPath = join(dir, 'plugin.json')
  await writeFile(manifestPath, '﻿' + JSON.stringify({ name: 'bom' }))
  expect(await loadPluginManifest(manifestPath, 'bom', 'test')).toMatchObject({
    name: 'bom',
  })
})
