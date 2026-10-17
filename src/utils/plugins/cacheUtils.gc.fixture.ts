import { mock } from 'bun:test'
import * as fsPromises from 'node:fs/promises'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

// All fault wrappers delegate to this immutable set of the actual filesystem calls.
export const real = { ...fsPromises }
// Allocate the owner root here instead of trusting an environment-provided path.
export const ownedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cc-cache-gc-fixture-')))
process.env.HOME = ownedRoot
process.env.CLAUDE_CONFIG_DIR = join(ownedRoot, 'config')
delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
export function owns(path: string): boolean {
  const rel = relative(ownedRoot, resolve(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
export const interventions: Array<{ op: string; args: string[]; detail?: string }> = []
export let intervene: ((op: string, args: unknown[]) => Promise<void>) | undefined
export function setIntervention(value: typeof intervene): void { intervene = value }
const wrapped = Object.fromEntries(Object.entries(real).map(([name, fn]) => [
  name, typeof fn !== 'function' ? fn : async (...args: unknown[]) => {
    if (intervene) await intervene(name, args)
    if (['copyFile', 'rename', 'rm', 'rmdir', 'unlink', 'writeFile', 'mkdir'].includes(name)) {
      interventions.push({ op: name, args: args.slice(0, 2).map(String) })
    }
    return Reflect.apply(fn, real, args)
  },
]))
mock.module('fs/promises', () => wrapped)

export async function tree(path: string): Promise<unknown> {
  try {
    const info = await real.lstat(path)
    if (info.isSymbolicLink()) return { type: 'symlink', target: await real.readlink(path) }
    if (info.isFile()) return { type: 'file', bytes: (await real.readFile(path)).toString('base64') }
    if (!info.isDirectory()) return { type: 'special', mode: info.mode }
    const entries = await real.readdir(path, { withFileTypes: true })
    const children: Record<string, unknown> = {}
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      children[entry.name] = await tree(join(path, entry.name))
    }
    return { type: 'directory', children }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
export async function observe(label: string, value: unknown): Promise<void> {
  await real.writeFile(join(ownedRoot, `${label}.json`), JSON.stringify(value, null, 2) + '\n')
  console.log(JSON.stringify({ label, evidence: join(ownedRoot, `${label}.json`) }))
}
export function fault(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Owned ${code}: ${path}`), { code, path })
}
export async function bootstrap() {
  // Source-only setup; no real credentials, CLI bootstrap, network, or production service overrides.
  Object.assign(globalThis, { MACRO: { VERSION: 'pl1-owned-source-test', BUILD_TIME: 'owned' } })
  globalThis.fetch = Object.assign(
    () => { throw new Error('Forbidden network in PL1 source test') },
    { preconnect() { throw new Error('Forbidden network in PL1 source test') } },
  )
  const state = await import('../../bootstrap/state.js')
  state.setOriginalCwd(ownedRoot)
  state.setAllowedSettingSources(['flagSettings'])
  state.setFlagSettingsInline({})
  const settings = await import('../settings/settingsCache.js')
  settings.resetSettingsCache()
  const loader = await import('./pluginLoader.js')
  const installed = await import('./installedPluginsManager.js')
  const gc = await import('./cacheUtils.js')
  const directories = await import('./pluginDirectories.js')
  const pluginsRoot = directories.getPluginsDirectory()
  if (!owns(pluginsRoot)) throw new Error(`Unowned plugins root: ${pluginsRoot}`)
  await real.mkdir(pluginsRoot, { recursive: true })
  return { state, settings, loader, installed, gc, pluginsRoot, cache: loader.getPluginCachePath() }
}
export type Entry = { installPath: string; version?: string; scope?: 'user' }
export async function record(path: string, entries: Record<string, Entry[]>): Promise<void> {
  const when = '2026-10-05T00:00:00.000Z'
  await real.writeFile(path, JSON.stringify({ version: 2, plugins: Object.fromEntries(
    Object.entries(entries).map(([key, rows]) => [key, rows.map(row => ({
      scope: 'user', version: '1.0.0', installedAt: when, lastUpdated: when, ...row,
    }))]),
  ) }))
}
export async function version(path: string, now: number, age: number): Promise<void> {
  await real.mkdir(path, { recursive: true })
  await real.writeFile(join(path, 'payload.txt'), `OWNED_VERSION:${basename(path)}`)
  const marker = join(path, '.orphaned_at')
  await real.writeFile(marker, String(now - age))
  const seconds = (now - age) / 1000
  await real.utimes(marker, seconds, seconds)
}
