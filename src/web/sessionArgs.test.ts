import { afterEach, expect, test } from 'bun:test'
import { resolve } from 'path'
import {
  getInlinePlugins,
  getInlinePluginsNoMcp,
  getInlinePluginUrls,
  getFlagSettingsPath,
  setFlagSettingsPath,
  setInlinePlugins,
  setInlinePluginsNoMcp,
  setInlinePluginUrls,
} from '../bootstrap/state.js'
import { webSessionArgs } from './sessionArgs.js'

const saved = {
  plugins: getInlinePlugins(),
  noMcp: getInlinePluginsNoMcp(),
  urls: getInlinePluginUrls(),
  settings: getFlagSettingsPath(),
  env: process.env.CLAUDE_CODE_PLUGIN_DIRS,
}
afterEach(() => {
  setInlinePlugins(saved.plugins)
  setInlinePluginsNoMcp(saved.noMcp)
  setInlinePluginUrls(saved.urls)
  setFlagSettingsPath(saved.settings)
  if (saved.env === undefined) delete process.env.CLAUDE_CODE_PLUGIN_DIRS
  else process.env.CLAUDE_CODE_PLUGIN_DIRS = saved.env
})

test('sessions get the plugin and settings flags claude web was started with', () => {
  delete process.env.CLAUDE_CODE_PLUGIN_DIRS
  setInlinePlugins(['rel/mod', '/abs/mod'])
  setInlinePluginsNoMcp(['/abs/nomcp'])
  setInlinePluginUrls(['https://example.test/p.zip'])
  setFlagSettingsPath('/abs/settings.json')
  expect(webSessionArgs(['claude', '--setting-sources', 'user,project', 'web'])).toEqual([
    '--plugin-dir', resolve('rel/mod'),
    '--plugin-dir', '/abs/mod',
    '--plugin-dir-no-mcp', '/abs/nomcp',
    '--plugin-url', 'https://example.test/p.zip',
    '--settings', '/abs/settings.json',
    '--setting-sources', 'user,project',
  ])
})

test('plugin folders from CLAUDE_CODE_PLUGIN_DIRS reach sessions through the environment, not a flag', () => {
  process.env.CLAUDE_CODE_PLUGIN_DIRS = '/env/mod'
  setInlinePlugins(['/env/mod', '/cli/mod'])
  setInlinePluginsNoMcp([])
  setInlinePluginUrls([])
  setFlagSettingsPath(undefined)
  expect(webSessionArgs(['claude', 'web'])).toEqual(['--plugin-dir', '/cli/mod'])
})
