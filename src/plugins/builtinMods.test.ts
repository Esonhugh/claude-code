import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { zipSync, strToU8 } from 'fflate'
import {
  initializeOfficialBuiltinMods,
  loadBuiltinModDefinitions,
  materializeBuiltinModsArchive,
  validateOfficialBuiltinModsProvenance,
} from './builtinMods.js'
import {
  clearBuiltinPlugins,
  getBuiltinPlugins,
} from './builtinPlugins.js'

const roots: string[] = []
afterEach(async () => {
  clearBuiltinPlugins()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function archive(entries: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'builtin-mods-archive-'))
  roots.push(root)
  const file = join(root, 'mods.zip')
  await writeFile(file, zipSync(Object.fromEntries(
    Object.entries(entries).map(([name, value]) => [name, strToU8(value)]),
  )))
  return { file, cache: join(root, 'cache') }
}

function withDuplicateCentralDirectoryEntry(bytes: Uint8Array): Uint8Array {
  let end = bytes.length - 22
  while (end >= 0 && new DataView(bytes.buffer, bytes.byteOffset + end, 4).getUint32(0, true) !== 0x06054b50)
    end--
  if (end < 0) throw new Error('ZIP end record not found')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const centralOffset = view.getUint32(end + 16, true)
  const nameLength = view.getUint16(centralOffset + 28, true)
  const extraLength = view.getUint16(centralOffset + 30, true)
  const commentLength = view.getUint16(centralOffset + 32, true)
  const recordLength = 46 + nameLength + extraLength + commentLength
  const duplicate = bytes.slice(centralOffset, centralOffset + recordLength)
  const output = new Uint8Array(bytes.length + recordLength)
  output.set(bytes.slice(0, end), 0)
  output.set(duplicate, end)
  output.set(bytes.slice(end), end + recordLength)
  const outputView = new DataView(output.buffer)
  outputView.setUint16(end + recordLength + 8, view.getUint16(end + 8, true) + 1, true)
  outputView.setUint16(end + recordLength + 10, view.getUint16(end + 10, true) + 1, true)
  outputView.setUint32(end + recordLength + 12, view.getUint32(end + 12, true) + recordLength, true)
  return output
}

async function expectNoPublishedTree(cache: string): Promise<void> {
  expect(await readdir(cache).catch(() => [])).toEqual([])
}

describe('built-in Mods archive', () => {
  test('materializes a complete content-addressed tree and reuses it', async () => {
    const fixture = await archive({
      'provenance.json': JSON.stringify({ version: '2.1.277', commit: '7974a70773fa229e4cc65aa1b356cc21f5c216c4' }),
      'agents-md/.claude-plugin/plugin.json': JSON.stringify({ name: 'agents-md' }),
      'agents-md/hooks/hooks.json': JSON.stringify({ modules: ['./register.ts'] }),
      'agents-md/hooks/register.ts': 'export function register() {}',
    })

    const first = await materializeBuiltinModsArchive(fixture.file, fixture.cache)
    const second = await materializeBuiltinModsArchive(fixture.file, fixture.cache)

    expect(second).toBe(first)
    expect(JSON.parse(await readFile(join(first, 'agents-md/.claude-plugin/plugin.json'), 'utf8'))).toEqual({ name: 'agents-md' })
    expect(await readFile(join(first, '.complete'), 'utf8')).toMatch(/^[a-f0-9]{64}\n[a-f0-9]{64}$/)
  })

  test('loads official plugin manifests and hook module descriptors from the materialized tree', async () => {
    const fixture = await archive({
      'provenance.json': JSON.stringify({ version: '2.1.277', commit: '7974a70773fa229e4cc65aa1b356cc21f5c216c4' }),
      'agents-md/.claude-plugin/plugin.json': JSON.stringify({ name: 'agents-md', description: 'Agents', userConfig: {} }),
      'agents-md/hooks/hooks.json': JSON.stringify({ modules: ['./register.ts'] }),
      'agents-md/hooks/register.ts': 'export function register() {}',
      'diff/.claude-plugin/plugin.json': JSON.stringify({ name: 'diff', description: 'Diff' }),
      'diff/hooks/hooks.json': JSON.stringify({ modules: ['./register.ts'] }),
      'diff/hooks/register.ts': 'export function register() {}',
      'telemetry/.claude-plugin/plugin.json': JSON.stringify({ name: 'telemetry', description: 'Telemetry' }),
      'telemetry/hooks/hooks.json': JSON.stringify({ modules: ['./register.ts'] }),
      'telemetry/hooks/register.ts': 'export function register() {}',
    })
    const root = await materializeBuiltinModsArchive(fixture.file, fixture.cache)

    const definitions = await loadBuiltinModDefinitions(root)

    expect(definitions.map(definition => definition.name)).toEqual(['agents-md', 'diff', 'telemetry'])
    expect(definitions[0]).toEqual(expect.objectContaining({
      path: join(root, 'agents-md'),
      manifest: expect.objectContaining({ name: 'agents-md', description: 'Agents' }),
      hookModules: [{
        configPath: join(root, 'agents-md/hooks/hooks.json'),
        paths: ['./register.ts'],
      }],
    }))
  })

  test('pins and initializes the production official archive', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const officialArchive = join(here, '..', '..', 'assets', 'builtin-mods-2.1.277.zip')
    const root = await mkdtemp(join(tmpdir(), 'builtin-mods-official-cache-'))
    roots.push(root)

    await initializeOfficialBuiltinMods(officialArchive, join(root, 'cache'))

    expect(getBuiltinPlugins().enabled.map(plugin => plugin.name)).toEqual(['agents-md', 'diff', 'telemetry'])
  })

  test('rejects a non-pinned archive for official initialization without publishing it', async () => {
    const fixture = await archive({
      'provenance.json': JSON.stringify({
        version: '2.1.277',
        commit: '7974a70773fa229e4cc65aa1b356cc21f5c216c4',
        declarationSha256: 'ac107a37c08ad46f8632edc1639b13a740fae0b8249a2245532adfd325e57d0d',
      }),
    })

    await expect(initializeOfficialBuiltinMods(fixture.file, fixture.cache))
      .rejects.toThrow('SHA-256')
    await expectNoPublishedTree(fixture.cache)
  })

  test.each([
    [{ commit: 'wrong' }, 'commit'],
    [{ version: '2.1.278' }, 'version'],
    [{ declarationSha256: '0'.repeat(64) }, 'declarationSha256'],
    [{ extra: true }, 'unrecognized'],
    [{ declarationSha256: undefined }, 'declarationSha256'],
  ])('strictly rejects invalid official provenance %s before publication', async (change, message) => {
    const fixture = await archive({
      'provenance.json': JSON.stringify({
        version: '2.1.277',
        commit: '7974a70773fa229e4cc65aa1b356cc21f5c216c4',
        declarationSha256: 'ac107a37c08ad46f8632edc1639b13a740fae0b8249a2245532adfd325e57d0d',
        ...change,
      }),
    })
    const unpacked = await materializeBuiltinModsArchive(fixture.file, fixture.cache)

    await expect(validateOfficialBuiltinModsProvenance(unpacked))
      .rejects.toThrow(new RegExp(message, 'i'))
  })

  test('does not publish a completed tree when official provenance validation fails', async () => {
    const fixture = await archive({ 'provenance.json': '{}' })
    const digest = createHash('sha256').update(await readFile(fixture.file)).digest('hex')

    await expect(materializeBuiltinModsArchive(fixture.file, fixture.cache, {
      validate: validateOfficialBuiltinModsProvenance,
    })).rejects.toThrow('provenance')

    await expect(readFile(join(fixture.cache, digest, '.complete'), 'utf8')).rejects.toThrow()
    await expectNoPublishedTree(fixture.cache)
  })

  test('recovers an incomplete digest cache tree', async () => {
    const fixture = await archive({
      'agents-md/.claude-plugin/plugin.json': JSON.stringify({ name: 'agents-md' }),
    })
    const bytes = await readFile(fixture.file)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const target = join(fixture.cache, digest)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'stale'), 'incomplete')

    const materialized = await materializeBuiltinModsArchive(fixture.file, fixture.cache)

    expect(materialized).toBe(target)
    expect(await readFile(join(target, '.complete'), 'utf8')).toMatch(new RegExp(`^${digest}\\n[a-f0-9]{64}$`))
    await expect(readFile(join(target, 'stale'), 'utf8')).rejects.toThrow()
  })

  test('concurrent materialization converges on one complete tree', async () => {
    const fixture = await archive({
      'agents-md/hooks/register.ts': 'official source',
    })

    const [first, second] = await Promise.all([
      materializeBuiltinModsArchive(fixture.file, fixture.cache),
      materializeBuiltinModsArchive(fixture.file, fixture.cache),
    ])

    expect(second).toBe(first)
    expect(await readFile(join(first, 'agents-md/hooks/register.ts'), 'utf8')).toBe('official source')
  })

  test('independent processes replace the same damaged target with one complete tree', async () => {
    const fixture = await archive({
      'agents-md/hooks/register.ts': 'official source',
      ...Object.fromEntries(Array.from({ length: 200 }, (_, index) => [
        `agents-md/generated/${index}.txt`,
        `content ${index}`,
      ])),
    })
    const bytes = await readFile(fixture.file)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const target = join(fixture.cache, digest)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, '.complete'), `${digest}\n${'0'.repeat(64)}`)
    await writeFile(join(target, 'damaged'), 'damaged')

    const processCount = 12
    const barrier = join(dirname(fixture.cache), 'barrier')
    await mkdir(barrier)
    const moduleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'builtinMods.ts')).href
    const script = `
      import { mkdir, readdir, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { materializeBuiltinModsArchive } from ${JSON.stringify(moduleUrl)};
      const [archive, cache, barrier, count] = process.argv.slice(1);
      const root = await materializeBuiltinModsArchive(archive, cache, {
        validate: async root => {
          if (!root.includes('.tmp.')) return;
          await mkdir(barrier, { recursive: true });
          await writeFile(join(barrier, String(process.pid)), 'ready');
          while ((await readdir(barrier)).length < Number(count)) await Bun.sleep(1);
        },
      });
      console.log(root);
    `
    const processes = Array.from({ length: processCount }, () => Bun.spawn([
      process.execPath,
      '--eval',
      script,
      fixture.file,
      fixture.cache,
      barrier,
      String(processCount),
    ], { stdout: 'pipe', stderr: 'pipe' }))
    const results = await Promise.all(processes.map(async process => ({
      exitCode: await process.exited,
      stdout: (await new Response(process.stdout).text()).trim(),
      stderr: await new Response(process.stderr).text(),
    })))

    expect(results).toEqual(results.map(() => ({ exitCode: 0, stdout: target, stderr: '' })))
    expect(await readFile(join(target, 'agents-md/hooks/register.ts'), 'utf8')).toBe('official source')
    expect(await readFile(join(target, '.complete'), 'utf8')).toMatch(new RegExp(`^${digest}\\n[a-f0-9]{64}$`))
    await expect(readFile(join(target, 'damaged'), 'utf8')).rejects.toThrow()
    expect((await readdir(fixture.cache)).filter(name => name.includes('.stale.'))).toEqual([])
  })

  test('independent processes replace a damaged non-directory target', async () => {
    const fixture = await archive({
      'agents-md/hooks/register.ts': 'official source',
    })
    const bytes = await readFile(fixture.file)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const target = join(fixture.cache, digest)
    await mkdir(fixture.cache, { recursive: true })
    await writeFile(target, 'damaged')

    const moduleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'builtinMods.ts')).href
    const script = `
      import { materializeBuiltinModsArchive } from ${JSON.stringify(moduleUrl)};
      const [archive, cache] = process.argv.slice(1);
      console.log(await materializeBuiltinModsArchive(archive, cache));
    `
    const processes = Array.from({ length: 2 }, () => Bun.spawn([
      process.execPath,
      '--eval',
      script,
      fixture.file,
      fixture.cache,
    ], { stdout: 'pipe', stderr: 'pipe' }))
    const results = await Promise.all(processes.map(async process => ({
      exitCode: await process.exited,
      stdout: (await new Response(process.stdout).text()).trim(),
      stderr: await new Response(process.stderr).text(),
    })))

    expect(results).toEqual(results.map(() => ({ exitCode: 0, stdout: target, stderr: '' })))
    expect(await readFile(join(target, 'agents-md/hooks/register.ts'), 'utf8')).toBe('official source')
    expect(await readFile(join(target, '.complete'), 'utf8')).toMatch(new RegExp(`^${digest}\\n[a-f0-9]{64}$`))
  })

  test('restores a modified completed cache tree from the archive', async () => {
    const fixture = await archive({
      'agents-md/hooks/register.ts': 'official source',
    })
    const root = await materializeBuiltinModsArchive(fixture.file, fixture.cache)
    await writeFile(join(root, 'agents-md/hooks/register.ts'), 'modified source')

    const materialized = await materializeBuiltinModsArchive(fixture.file, fixture.cache)

    expect(materialized).toBe(root)
    expect(await readFile(join(root, 'agents-md/hooks/register.ts'), 'utf8')).toBe('official source')
  })

  test.each([
    '../escape.ts',
    '/absolute.ts',
    'agents-md/../../escape.ts',
    'agents-md\\escape.ts',
  ])('rejects unsafe archive entry %s without publishing a cache tree', async name => {
    const fixture = await archive({
      'provenance.json': '{}',
      [name]: 'bad',
    })

    await expect(materializeBuiltinModsArchive(fixture.file, fixture.cache)).rejects.toThrow('unsafe entry')
    await expectNoPublishedTree(fixture.cache)
  })

  test.each([
    [['Mod/file.ts', 'mod/file.ts'], 'portable'],
    [['café.ts', 'café.ts'], 'portable'],
    [['mod', 'mod/file.ts'], 'file/directory'],
    [['mod/', 'mod'], 'file/directory'],
  ])('rejects %s entry collisions before writing', async ([first, second], message) => {
    const fixture = await archive({ [first]: 'first', [second]: 'second' })

    await expect(materializeBuiltinModsArchive(fixture.file, fixture.cache))
      .rejects.toThrow(new RegExp(message, 'i'))
    await expectNoPublishedTree(fixture.cache)
  })

  test('rejects duplicate central-directory entries before fflate object flattening', async () => {
    const fixture = await archive({ 'mod/file.ts': 'content' })
    await writeFile(fixture.file, withDuplicateCentralDirectoryEntry(await readFile(fixture.file)))

    await expect(materializeBuiltinModsArchive(fixture.file, fixture.cache))
      .rejects.toThrow(/duplicate.*mod\/file\.ts/i)
    await expectNoPublishedTree(fixture.cache)
  })
})
