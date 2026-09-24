/**
 * Built-in Plugin Initialization
 *
 * Initializes built-in plugins that ship with the CLI and appear in the
 * /plugin UI for users to enable/disable.
 *
 * Not all bundled features should be built-in plugins — use this for
 * features that users should be able to explicitly enable/disable. For
 * features with complex setup or automatic-enabling logic (e.g.
 * claude-in-chrome), use src/skills/bundled/ instead.
 *
 * To add a new built-in plugin:
 * 1. Import registerBuiltinPlugin from '../builtinPlugins.js'
 * 2. Call registerBuiltinPlugin() with the plugin definition here
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CACHE_PATHS } from '../../utils/cachePaths.js'
import { initializeOfficialBuiltinMods } from '../builtinMods.js'

const archiveName = 'builtin-mods-2.1.277.zip'

function builtinModsArchive(): string | undefined {
  if (process.env.CLAUDE_CODE_BUILTIN_MODS_ARCHIVE)
    return process.env.CLAUDE_CODE_BUILTIN_MODS_ARCHIVE
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    join(here, 'assets', archiveName),
    join(here, '..', '..', '..', 'assets', archiveName),
  ].find(existsSync)
}

/**
 * Initialize built-in plugins. Called during CLI startup.
 */
export async function initBuiltinPlugins(): Promise<void> {
  const archive = builtinModsArchive()
  if (!archive)
    throw new Error(`Built-in Mods archive is missing: ${archiveName}`)
  await initializeOfficialBuiltinMods(archive, CACHE_PATHS.builtinMods())
}
