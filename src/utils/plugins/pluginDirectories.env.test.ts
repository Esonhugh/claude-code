import { afterEach, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { delimiter, resolve } from 'node:path'
import { getPluginDirsFromEnvironment, mergePluginDirectories, settlePluginDirsEnvironment } from './pluginDirectories.js'

const original = process.env.CLAUDE_CODE_PLUGIN_DIRS
afterEach(() => {
  if (original === undefined) delete process.env.CLAUDE_CODE_PLUGIN_DIRS
  else process.env.CLAUDE_CODE_PLUGIN_DIRS = original
})

// Official 2.1.292 native: trim, expand ~, skip relative/network folders;
// preserve duplicates in the normalized environment, deduplicate only on merge.
test('environment directories trim, expand tilde, resolve aliases and retain duplicates', () => {
  delete process.env.CLAUDE_CODE_PLUGIN_DIRS
  expect(getPluginDirsFromEnvironment()).toEqual([])
  expect(getPluginDirsFromEnvironment('')).toEqual([])
  expect(getPluginDirsFromEnvironment([' /tmp/mod-a/./ ', '', ' ~/mods ', '/tmp/mod-a'].join(delimiter)))
    .toEqual([resolve('/tmp/mod-a'), resolve(homedir(), 'mods'), resolve('/tmp/mod-a')])
})

test('invalid environment directories are skipped without discarding valid local folders', () => {
  expect(getPluginDirsFromEnvironment(['/tmp/mod-a', 'relative-mod', '//server/plugins', '/Network/Servers/x', '/net/server', '/tmp/mod-b'].join(delimiter)))
    .toEqual([resolve('/tmp/mod-a'), resolve('/tmp/mod-b')])
  expect(getPluginDirsFromEnvironment(['relative-mod', '//server/plugins'].join(delimiter))).toEqual([])
})

// The 292 path guard examines network prefixes before path resolution.
test('network prefixes stay refused even when traversal would normalize to a local path', () => {
  expect(getPluginDirsFromEnvironment(['/net/server/../..', '/NeT/server', '/Network/../tmp', '/ne\u200ct/server', '/tmp/../net/server', '/network.', '/net'].join(delimiter)))
    .toEqual([resolve('/network.'), resolve('/net')])
})

test('settling rewrites a defined variable with valid normalized paths and keeps it unset otherwise', () => {
  delete process.env.CLAUDE_CODE_PLUGIN_DIRS
  expect(settlePluginDirsEnvironment()).toEqual([])
  expect(process.env.CLAUDE_CODE_PLUGIN_DIRS).toBeUndefined()
  process.env.CLAUDE_CODE_PLUGIN_DIRS = [' /tmp/mod-a/./ ', 'relative-mod', '/tmp/mod-a'].join(delimiter)
  expect(settlePluginDirsEnvironment()).toEqual([resolve('/tmp/mod-a'), resolve('/tmp/mod-a')])
  expect(process.env.CLAUDE_CODE_PLUGIN_DIRS).toBe([resolve('/tmp/mod-a'), resolve('/tmp/mod-a')].join(delimiter))
  process.env.CLAUDE_CODE_PLUGIN_DIRS = 'relative-mod'
  expect(settlePluginDirsEnvironment()).toEqual([])
  expect(process.env.CLAUDE_CODE_PLUGIN_DIRS).toBe('')
})

test('CLI directories come first and aliases deduplicate by resolved path, keeping the first spelling', () => {
  expect(mergePluginDirectories(['/tmp/mod-b/.', '/tmp/mod-a/.'], [resolve('/tmp/mod-a'), resolve('/tmp/mod-b'), '/tmp/mod-c']))
    .toEqual(['/tmp/mod-b/.', '/tmp/mod-a/.', '/tmp/mod-c'])
  expect(mergePluginDirectories(['relative-mod'], [resolve('relative-mod')])).toEqual(['relative-mod'])
})
