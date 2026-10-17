import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setIsInteractive } from '../../bootstrap/state.js'
import { enableConfigs } from '../../utils/config.js'
import { clearBuiltinPlugins, getBuiltinPluginDefinition } from '../builtinPlugins.js'
import { readOfficialShippedDiffContract } from '../builtinShippedMods.js'
import { unzipArchive } from '../builtinMods.js'
import { initBuiltinPlugins } from './index.js'
const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_BUILTIN_DIFF_ARCHIVE'] as const
let root: string
let saved: (string | undefined)[]
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'diff-reference-')))
  saved = keys.map(key => process.env[key])
  process.env.HOME = root; process.env.CLAUDE_CONFIG_DIR = root; process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = root
  delete process.env.CLAUDE_CODE_ENTRYPOINT; delete process.env.CLAUDE_CODE_BUILTIN_DIFF_ARCHIVE
  enableConfigs(); setIsInteractive(true); clearBuiltinPlugins()
})
afterEach(async () => {
  clearBuiltinPlugins(); setIsInteractive(false)
  keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index] })
  await rm(root, { recursive: true, force: true })
})
test('the fixed reference archive loads without rewriting its official register source', async () => {
  const archive = new URL('../../../assets/builtin-diff-2.1.292.zip', import.meta.url).pathname
  const original = unzipArchive(await readFile(archive))
  const { definition, files } = await readOfficialShippedDiffContract(archive)
  expect(definition.name).toBe('cc-plugin-diff'); expect(definition.version).toBe('2.1.292')
  expect(files['hooks/register.js']).toEqual(original['cc-plugin-diff/hooks/register.js'])
  expect(JSON.parse(new TextDecoder().decode(original['provenance.json'])).binarySha256).toBe('97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f')
})
test('production initialization admits the fixed official292 archive through its verified builtin path', async () => {
  process.env.CLAUDE_CODE_BUILTIN_DIFF_ARCHIVE = new URL('../../../assets/builtin-diff-2.1.292.zip', import.meta.url).pathname
  await initBuiltinPlugins()
  expect(getBuiltinPluginDefinition('cc-plugin-diff')?.version).toBe('2.1.292')
  expect(getBuiltinPluginDefinition('diff')).toBeUndefined()
})
test('tampered reference bytes cannot issue an official builtin identity', async () => {
  const bytes = await readFile(new URL('../../../assets/builtin-diff-2.1.292.zip', import.meta.url))
  bytes[bytes.length - 1] ^= 1
  const archive = join(root, 'tampered.zip'); await writeFile(archive, bytes)
  await expect(readOfficialShippedDiffContract(archive)).rejects.toThrow('SHA-256 mismatch')
})
