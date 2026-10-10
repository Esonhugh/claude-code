import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { readInstalledPluginsForContractValidation } from './installedPluginsManager.js'
import { pluginDataDirPath } from './pluginDirectories.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'
import { getVersionedCachePath } from './pluginLoader.js'
import type { InstalledPluginsFileV2, PluginScope } from './schemas.js'

type InstalledPluginsMapV2 = InstalledPluginsFileV2['plugins']

type SharedFolder = 'folder' | 'data'
type Holder = {
  id: string
  shares: SharedFolder
  installations: Array<{ scope: PluginScope; projectPath?: string }>
}
export type PluginFolderCollision = {
  pluginId: string
} & (
  | { sharedWith: 'installed'; holders: Holder[] }
  | { sharedWith: 'same-install'; twin: string; shares: SharedFolder }
)

export class PluginFolderCollisionError extends Error {
  constructor(
    collision: PluginFolderCollision,
    askedFor: string,
    surface: 'cli' | 'ui' = 'cli',
    rootKept = false,
  ) {
    super(formatPluginFolderCollision(collision, askedFor, surface, rootKept))
    this.name = 'PluginFolderCollisionError'
  }
}

function sameFolder(left: string, right: string): boolean {
  const fold = (path: string) =>
    process.platform === 'darwin' || process.platform === 'win32'
      ? path.toLowerCase()
      : path
  return fold(left) === fold(right)
}

function sharedFolder(left: string, right: string): SharedFolder | null {
  if (sameFolder(getVersionedCachePath(left, ''), getVersionedCachePath(right, '')))
    return 'folder'
  return sameFolder(pluginDataDirPath(left), pluginDataDirPath(right)) ? 'data' : null
}

/** Official 2.1.292 exempts existing ids and npm's separately bound names. */
export function findPluginFolderCollision(
  ids: readonly string[],
  installed: InstalledPluginsMapV2,
): PluginFolderCollision | null {
  const fresh = (id: string) => !id.endsWith('@npm') && (installed[id]?.length ?? 0) === 0
  for (const id of ids) {
    if (!fresh(id)) continue
    const holders = Object.entries(installed).flatMap(([other, entries]): Holder[] => {
      const shares = other !== id && entries.length > 0 ? sharedFolder(other, id) : null
      return shares === null ? [] : [{ id: other, shares, installations: entries.map(({ scope, projectPath }) => ({ scope, projectPath })) }]
    })
    if (holders.length > 0) return { pluginId: id, sharedWith: 'installed', holders }
    for (const other of ids) {
      const shares = other !== id && fresh(other) ? sharedFolder(other, id) : null
      if (shares !== null) return { pluginId: id, sharedWith: 'same-install', twin: other, shares }
    }
  }
  return null
}

/** CLI and interactive install share the collision rule but offer different actions. */
export function formatPluginFolderCollision(
  collision: PluginFolderCollision,
  askedFor: string,
  surface: 'cli' | 'ui' = 'cli',
  rootKept = false,
): string {
  const refused = collision.pluginId
  const holders = collision.sharedWith === 'installed' ? collision.holders : []
  const owners = collision.sharedWith === 'installed' ? holders : [{ id: collision.twin, shares: collision.shares }]
  const quoted = (id: string) => `"${id}"`
  const capitals = owners.some(({ id, shares }) => shares === 'folder'
    ? getVersionedCachePath(id, '') !== getVersionedCachePath(refused, '')
    : pluginDataDirPath(id) !== pluginDataDirPath(refused))
  const punctuation = owners.some(({ id, shares }) => shares === 'folder' && id.toLowerCase() !== refused.toLowerCase())
  const atSign = owners.some(({ shares }) => shares === 'data')
  const why = `because ${owners.length > 1 ? 'their' : 'the two'} ids ${atSign
    ? `are the same once "@" and "." are written as "-"${capitals ? ' and capitals are ignored' : ''}`
    : capitals || punctuation
      ? `differ only in ${capitals ? `capitals${punctuation ? ', ' : ''}` : ''}${punctuation ? '"." and "-"' : ''}`
      : 'give one folder name'}`
  const what = owners.every(({ shares }) => shares === 'folder') ? 'its folder'
    : owners.every(({ shares }) => shares === 'data') ? 'its saved data' : 'its folder or its saved data'
  const keptRoot = refused !== askedFor && (rootKept || holders.some(({ id }) => id === askedFor))
  const start = keptRoot ? `${quoted(refused)} was not installed: ${quoted(askedFor)} needs it, but it`
    : refused === askedFor ? `${quoted(refused)} was not installed: it`
      : `${quoted(askedFor)} was not installed: it needs ${quoted(refused)}, which`
  const rootNote = keptRoot ? ` ${quoted(askedFor)} will not load without it.` : ''
  if (collision.sharedWith === 'same-install' || holders.some(({ id }) => id === askedFor)) {
    const twin = collision.sharedWith === 'same-install' ? collision.twin : askedFor
    const maintainer = parsePluginIdentifier(twin).marketplace === parsePluginIdentifier(refused).marketplace
      ? "Only the marketplace's maintainer can fix this, by renaming one of them."
      : 'Only a maintainer of one of the two marketplaces can fix this, by renaming one of them.'
    return `${start} would share ${what} with ${quoted(twin)}${twin === askedFor ? '' : ', which the same install brings along'}, ${why}.${rootNote} ${maintainer}`
  }
  const installs = holders.flatMap(({ id, installations }) => installations.map(entry => ({ id, ...entry })))
  const scoped = (entry: { scope: PluginScope }) => entry.scope === 'project' || entry.scope === 'local'
  const anotherProject = (entry: { scope: PluginScope; projectPath?: string }) => scoped(entry) && (entry.projectPath === undefined || entry.projectPath !== getCwd())
  const managed = installs.filter(({ scope }) => scope === 'managed').length
  const verb = holders.length > 1 ? 'are' : 'is'
  const installedWhere = managed > 0 && managed === installs.length ? 'which your organization installed'
    : managed > 0 ? `which ${verb} installed, also by your organization`
      : installs.length > 0 && installs.every(anotherProject)
        ? `which ${verb} installed in ${new Set(installs.map(({ projectPath }) => projectPath)).size > 1 ? 'other projects' : 'another project'}`
        : `which ${verb} installed`
  const names = new Intl.ListFormat('en', { type: 'conjunction' }).format(holders.map(({ id }) => quoted(id)))
  const message = `${start} would share ${what} with ${names}, ${installedWhere}, ${why}.${rootNote}${holders.length > 1 ? '' : ' Only one of the two can be installed.'}`
  if (managed > 0 || installs.length === 0) return `${message}${managed > 0 ? ' Ask your administrator.' : ''}`
  const commands = [...new Set(installs.map(entry => {
    if (anotherProject(entry) && entry.projectPath === undefined) return `uninstall ${quoted(entry.id)} in the project it is installed for`
    const command = surface === 'cli'
      ? `run \`claude plugin uninstall ${entry.id}${entry.scope === 'user' ? '' : ` --scope ${entry.scope}`}\``
      : `uninstall ${quoted(entry.id)}${entry.scope === 'user' || anotherProject(entry) ? '' : ` at ${entry.scope} scope`}`
    return anotherProject(entry) ? `${command} in “${entry.projectPath}”` : command
  }))]
  const instead = refused === askedFor ? `${quoted(refused)} instead` : keptRoot ? `${quoted(refused)} as well` : quoted(askedFor)
  const dataHint = surface === 'cli' ? 'Uninstalling a plugin also deletes its saved data.'
    : "When it asks, let it delete the plugin's saved data: the new plugin would otherwise start with it."
  return `${message} To install ${instead}, first ${commands.length > 1 ? `do each of these: ${commands.join('; ')}` : commands[0]}. ${dataHint}`
}

/** An unreadable registry is not evidence that no plugin still owns its data. */
export function getPluginIdsForDataCleanup(): string[] | null {
  try {
    return Object.entries(readInstalledPluginsForContractValidation().plugins)
      .filter(([, entries]) => entries.length > 0)
      .map(([id]) => id)
  } catch (error) {
    logForDebugging(`Keeping plugin data: installed plugin records cannot be read (${errorMessage(error)})`, { level: 'warn' })
    return null
  }
}
