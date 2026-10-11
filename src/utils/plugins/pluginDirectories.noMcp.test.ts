import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import * as directories from './pluginDirectories.js'

// Official 2.1.292 WDt and native runs: only environment paths are filtered;
// explicit regular CLI/SDK sources retain their own discovery semantics.
test('environment paths covered by a no-MCP source are omitted without changing the input', () => {
  const paths = [resolve('a'), resolve('b'), resolve('a')]
  const original = [...paths]
  expect(directories.filterNoMcpEnvironmentPluginDirectories(paths, ['./a'])).toEqual([resolve('b')])
  expect(paths).toEqual(original)
})

test('environment filtering resolves lexical aliases and retains unrelated paths in order', () => {
  const paths = [resolve('a'), resolve('b'), resolve('c')]
  expect(directories.filterNoMcpEnvironmentPluginDirectories(paths, ['./nested/../b'])).toEqual([resolve('a'), resolve('c')])
  expect(directories.filterNoMcpEnvironmentPluginDirectories(paths, [])).toEqual(paths)
})
