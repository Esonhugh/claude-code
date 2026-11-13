import { resolve } from 'path'
import {
  getFlagSettingsPath,
  getInlinePlugins,
  getInlinePluginsNoMcp,
  getInlinePluginUrls,
} from '../bootstrap/state.js'
import { eagerParseCliFlag } from '../utils/cliArgs.js'
import { getPluginDirsFromEnvironment } from '../utils/plugins/pluginDirectories.js'

/**
 * The plugin and settings flags `claude web` was started with, for every session it starts:
 * they load in the web process only, and sessions run in other folders, so paths are absolute.
 * CLAUDE_CODE_PLUGIN_DIRS reaches the sessions in their environment.
 */
export function webSessionArgs(argv: string[] = process.argv): string[] {
  const fromEnv = new Set(getPluginDirsFromEnvironment())
  const settings = getFlagSettingsPath()
  const settingSources = eagerParseCliFlag('--setting-sources', argv)
  return [
    ...getInlinePlugins()
      .map(dir => resolve(dir))
      .filter(dir => !fromEnv.has(dir))
      .flatMap(dir => ['--plugin-dir', dir]),
    ...getInlinePluginsNoMcp().flatMap(dir => ['--plugin-dir-no-mcp', resolve(dir)]),
    ...getInlinePluginUrls().flatMap(url => ['--plugin-url', url]),
    ...(settings ? ['--settings', settings] : []),
    ...(settingSources !== undefined ? ['--setting-sources', settingSources] : []),
  ]
}
