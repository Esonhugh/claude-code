import { expect, test } from 'bun:test'
import { installFailureMessage } from './ide.js'

test('extension install failures read like 2.1.311 (no exit-code prefix)', () => {
  const error = 'Command failed with ENOENT: code --force --install-extension anthropic.claude-code\nExecutable not found in $PATH: "code"'
  expect(installFailureMessage('/usr/bin/code', { code: 1, error, stderr: '' })).toBe(error)
  expect(installFailureMessage('/usr/bin/code', { code: 2, error: '2', stderr: 'boom\n' })).toBe(
    'The code command exited with status 2\nboom',
  )
  expect(installFailureMessage('code', { code: 1, error: 'failed: boom', stderr: 'boom' })).toBe('failed: boom')
})
