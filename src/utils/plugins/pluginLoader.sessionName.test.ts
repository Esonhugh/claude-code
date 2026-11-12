import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadSessionOnlyPlugins } from './pluginLoader.js'

let directory: string | undefined
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

async function sessionPlugin(name: string): Promise<string> {
  const path = join(directory!, String(Math.random()).slice(2))
  await mkdir(join(path, '.claude-plugin'), { recursive: true })
  await writeFile(join(path, '.claude-plugin/plugin.json'), JSON.stringify({ name }))
  return path
}

// Official 2.1.322 refuses these names for a plugin loaded by path and keeps
// names such as "..", ".hidden" or non-ASCII ones.
test('--plugin-dir refuses a manifest name with "@", ":", whitespace, path separators or invisible characters', async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'session-plugin-name-')))
  for (const name of ['../evil', 'x/y', 'a\\b', 'a@b', 'a:b', 'a​b', 'a\tb']) {
    const path = await sessionPlugin(name)
    const result = await loadSessionOnlyPlugins([path], {}, false)
    expect(result.plugins).toEqual([])
    expect(result.errors).toEqual([{
      type: 'manifest-validation-error',
      source: 'inline[0]',
      manifestPath: join(path, '.claude-plugin/plugin.json'),
      validationErrors: [
        `name: "${name}" is not a valid plugin name (must be non-empty and must not contain "@", ":", whitespace, path separators, or invisible/control characters)`,
      ],
    }])
  }
  for (const name of ['..', '.hidden', '_x', 'Ünï', 'a..b']) {
    const result = await loadSessionOnlyPlugins([await sessionPlugin(name)], {}, false)
    expect(result.plugins.map(plugin => plugin.name)).toEqual([name])
  }
})
