import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix } from 'node:path'
import { unzipSync } from 'fflate'
import { z } from 'zod'
import type { BuiltinPluginDefinition } from '../types/plugin.js'
import {
  PluginHooksSchema,
  PluginManifestSchema,
} from '../utils/plugins/schemas.js'
import { registerBuiltinPlugin } from './builtinPlugins.js'

function validateEntry(name: string): string {
  if (
    name.length === 0 ||
    isAbsolute(name) ||
    name.includes('\\') ||
    posix.normalize(name) !== name ||
    name === '..' ||
    name.startsWith('../')
  ) {
    throw new Error(`Built-in Mods archive has unsafe entry: ${name}`)
  }
  return name
}

const OFFICIAL_MODS = ['agents-md', 'diff', 'telemetry'] as const
const OFFICIAL_ARCHIVE_SHA256 = '7529d618a2048f43b92070be542bfa6171d78932cdd24aed73b3392a33c6f161'
const OfficialProvenanceSchema = z.strictObject({
  version: z.literal('2.1.277'),
  commit: z.literal('7974a70773fa229e4cc65aa1b356cc21f5c216c4'),
  declarationSha256: z.literal('ac107a37c08ad46f8632edc1639b13a740fae0b8249a2245532adfd325e57d0d'),
})

export async function validateOfficialBuiltinModsProvenance(root: string): Promise<void> {
  let received: unknown
  try {
    received = JSON.parse(await readFile(join(root, 'provenance.json'), 'utf8'))
  } catch (error) {
    throw new Error('Built-in Mods provenance must be valid JSON', { cause: error })
  }
  const result = OfficialProvenanceSchema.safeParse(received)
  if (!result.success)
    throw new Error(`Built-in Mods provenance is invalid: ${z.prettifyError(result.error)}`)
}

function portableEntryName(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

function validateEntryCollisions(names: string[]): void {
  const entries = new Map<string, string>()
  const files = new Map<string, string>()
  const directories = new Map<string, string>()
  for (const name of names) {
    const path = name.endsWith('/') ? name.slice(0, -1) : name
    const portable = portableEntryName(path)
    const existing = entries.get(portable)
    if (existing) {
      const kind = existing.endsWith('/') !== name.endsWith('/')
        ? 'file/directory'
        : 'portable entry'
      throw new Error(`Built-in Mods archive has ${kind} collision: ${existing} and ${name}`)
    }

    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) {
      const directory = portableEntryName(parts.slice(0, index).join('/'))
      const file = files.get(directory)
      if (file)
        throw new Error(`Built-in Mods archive has file/directory collision: ${file} and ${name}`)
      directories.set(directory, name)
    }
    if (name.endsWith('/')) {
      const file = files.get(portable)
      if (file)
        throw new Error(`Built-in Mods archive has file/directory collision: ${file} and ${name}`)
      directories.set(portable, name)
    } else {
      const directory = directories.get(portable)
      if (directory)
        throw new Error(`Built-in Mods archive has file/directory collision: ${directory} and ${name}`)
      files.set(portable, name)
    }
    entries.set(portable, name)
  }
}

function unzipArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  const rawNames = new Set<string>()
  const names: string[] = []
  const entries = unzipSync(bytes, {
    filter: ({ name }) => {
      validateEntry(name)
      if (rawNames.has(name))
        throw new Error(`Built-in Mods archive has duplicate entry: ${name}`)
      rawNames.add(name)
      names.push(name)
      return true
    },
  })
  validateEntryCollisions(names)
  return entries
}

async function treeDigest(root: string, relative = ''): Promise<string> {
  const hash = createHash('sha256')
  for (const name of (await readdir(join(root, relative), { withFileTypes: true }))
    .filter(entry => relative !== '' || entry.name !== '.complete')
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relative ? `${relative}/${name.name}` : name.name
    hash.update(name.isDirectory() ? `d\0${path}\0` : `f\0${path}\0`)
    hash.update(name.isDirectory() ? await treeDigest(root, path) : await readFile(join(root, path)))
  }
  return hash.digest('hex')
}

async function completeTree(root: string, digest: string): Promise<boolean> {
  try {
    const [archiveDigest, contentDigest] = (await readFile(join(root, '.complete'), 'utf8')).trim().split('\n')
    return archiveDigest === digest && contentDigest === await treeDigest(root)
  } catch {
    return false
  }
}

export async function loadBuiltinModDefinitions(
  root: string,
): Promise<BuiltinPluginDefinition[]> {
  return Promise.all(OFFICIAL_MODS.map(async name => {
    const path = join(root, name)
    const manifest = PluginManifestSchema().parse(JSON.parse(
      await readFile(join(path, '.claude-plugin', 'plugin.json'), 'utf8'),
    ))
    if (manifest.name !== name)
      throw new Error(`Built-in Mod manifest name mismatch: expected ${name}, received ${manifest.name}`)
    const configPath = join(path, 'hooks', 'hooks.json')
    const hooks = PluginHooksSchema().parse(JSON.parse(
      await readFile(configPath, 'utf8'),
    ))
    if (!hooks.modules?.length)
      throw new Error(`Built-in Mod ${name} has no hook modules`)
    return {
      name,
      description: manifest.description ?? name,
      version: manifest.version,
      manifest,
      path,
      hooks: hooks.hooks,
      hookModules: [{ configPath, paths: hooks.modules }],
    }
  }))
}

export async function initializeOfficialBuiltinMods(
  archivePath: string,
  cacheRoot: string,
): Promise<void> {
  const bytes = await readFile(archivePath)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== OFFICIAL_ARCHIVE_SHA256)
    throw new Error(`Built-in Mods archive SHA-256 must be ${OFFICIAL_ARCHIVE_SHA256}, received ${digest}`)
  const root = await materializeBuiltinModsArchive(archivePath, cacheRoot, {
    bytes,
    validate: validateOfficialBuiltinModsProvenance,
  })
  for (const definition of await loadBuiltinModDefinitions(root))
    registerBuiltinPlugin(definition)
}

export async function materializeBuiltinModsArchive(
  archivePath: string,
  cacheRoot: string,
  options: {
    bytes?: Uint8Array
    validate?: (root: string) => Promise<void>
  } = {},
): Promise<string> {
  const bytes = options.bytes ?? await readFile(archivePath)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const target = join(cacheRoot, digest)
  if (await completeTree(target, digest)) {
    await options.validate?.(target)
    return target
  }

  const entries = unzipArchive(bytes)
  const temporary = `${target}.tmp.${process.pid}.${randomUUID()}`
  await mkdir(temporary, { recursive: true })
  try {
    for (const [rawName, content] of Object.entries(entries)) {
      const name = validateEntry(rawName)
      if (name.endsWith('/')) continue
      const file = join(temporary, ...name.split('/'))
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content)
    }
    await options.validate?.(temporary)
    await writeFile(join(temporary, '.complete'), `${digest}\n${await treeDigest(temporary)}`)
    await mkdir(cacheRoot, { recursive: true })
    while (true) {
      try {
        await rename(temporary, target)
        return target
      } catch (error) {
        if (await completeTree(target, digest)) {
          await options.validate?.(target)
          return target
        }
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'ENOTDIR') throw error
      }

      const stale = `${target}.stale.${process.pid}.${randomUUID()}`
      try {
        await rename(target, stale)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      try {
        await rename(temporary, target)
      } catch (error) {
        if (await completeTree(target, digest)) {
          try {
            await options.validate?.(target)
          } catch (validationError) {
            await rm(target, { recursive: true, force: true })
            try {
              await rename(stale, target)
            } catch (restoreError) {
              throw new AggregateError([validationError, restoreError], 'Built-in Mods validation failed and the previous cache tree could not be restored')
            }
            throw validationError
          }
          await rm(stale, { recursive: true, force: true })
          return target
        }
        try {
          await rename(stale, target)
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], 'Built-in Mods publication failed and the previous cache tree could not be restored')
        }
        throw error
      }
      await rm(stale, { recursive: true, force: true })
      return target
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
