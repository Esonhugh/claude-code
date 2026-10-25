import { expect, test } from 'bun:test'
import { dropProcessWrapperBinaryArg } from './processWrapperArgs.js'

const bundled =
  '/Users/me/.vscode/extensions/anthropic.claude-code-2.1.310-darwin-arm64/resources/native-binary/claude'

test.each([
  [[bundled, 'plugin', 'list', '--json'], ['plugin', 'list', '--json']],
  [[bundled, 'auth', 'status', '--json'], ['auth', 'status', '--json']],
  [['C:\\ext\\resources\\native-binary\\claude.exe', '--output-format', 'stream-json'], ['--output-format', 'stream-json']],
  [['plugin', 'list', '--json'], ['plugin', 'list', '--json']],
  [['-p', 'explain native-binary/claude'], ['-p', 'explain native-binary/claude']],
  [['/usr/local/bin/claude', 'plugin', 'list'], ['/usr/local/bin/claude', 'plugin', 'list']],
])('drops only the extension bundled binary: %j', (args, expected) => {
  expect(dropProcessWrapperBinaryArg(['bun', 'claude', ...args])).toEqual(['bun', 'claude', ...expected])
})
