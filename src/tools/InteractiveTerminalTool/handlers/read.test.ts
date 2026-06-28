import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

import { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'
import { FakePtyDriver } from '../../../utils/pty/__fixtures__/FakePtyDriver.js'
import {
  compactReadOutput,
  truncateUtf8Bytes,
} from '../compressReadOutput.js'
import { handleRead } from './read.js'

test('compactReadOutput collapses repeated lines and blank runs', () => {
  const input = [
    'ready',
    'same',
    'same',
    'same',
    '',
    '',
    '',
    '',
    'done',
  ].join('\n')

  const result = compactReadOutput(input, {
    maxBytes: 8192,
    maxLineChars: 240,
    maxLines: 80,
  })

  assert.equal(
    result.text,
    [
      'ready',
      'same',
      '[... repeated 2 more times ...]',
      '[... 4 blank lines omitted ...]',
      'done',
    ].join('\n'),
  )
  assert.equal(result.compressed, true)
  assert.equal(result.omittedLines, 6)
})

test('compactReadOutput elides long lines in the middle', () => {
  const result = compactReadOutput(
    'prefix-abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz-suffix',
    {
      maxBytes: 8192,
      maxLineChars: 48,
      maxLines: 80,
    },
  )

  assert.match(result.text, /^prefix-/)
  assert.match(result.text, /suffix$/)
  assert.match(result.text, /\[\.\.\. \d+ chars omitted \.\.\.\]/)
  assert.equal(result.compressed, true)
  assert.ok(result.omittedChars > 0)
})

test('compactReadOutput keeps top and bottom context when line budget is exceeded', () => {
  const input = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join('\n')
  const result = compactReadOutput(input, {
    maxBytes: 8192,
    maxLineChars: 240,
    maxLines: 12,
  })

  assert.ok(result.text.startsWith('line-1\nline-2'))
  assert.match(result.text, /\[\.\.\. 9 lines omitted \.\.\.\]/)
  assert.ok(result.text.endsWith('line-20'))
  assert.equal(result.omittedLines, 9)
})

test('truncateUtf8Bytes does not split CJK or emoji characters', () => {
  assert.equal(truncateUtf8Bytes('你好🙂abc', 10), '你好🙂')
})

test('handleRead default mode returns compact metadata and compressed text', () => {
  const manager = new PtySessionManager({
    driver: new FakePtyDriver(),
  })
  const session = manager.open({ cwd: '/tmp/project', cols: 80, rows: 24 })
  manager.write(
    session.sessionId,
    `${Array.from({ length: 6 }, () => 'repeat').join('\n')}\n`,
  )

  const result = handleRead(manager, {
    action: 'read',
    cursor: 0,
    maxBytes: 8192,
    maxLineChars: 240,
    maxLines: 80,
    mode: 'compact',
    previewBytes: 2000,
    sessionId: session.sessionId,
  })

  assert.equal(result.mode, 'compact')
  assert.equal(result.compressed, true)
  assert.match(result.text, /\[\.\.\. repeated \d+ more times \.\.\.\]/)
  assert.ok(result.originalBytes >= result.returnedBytes)
  assert.ok(result.omittedLines > 0)
})

test('handleRead full mode preserves current visible snapshot behavior', () => {
  const manager = new PtySessionManager({
    driver: new FakePtyDriver(),
  })
  const session = manager.open({ cwd: '/tmp/project', cols: 80, rows: 24 })
  manager.write(session.sessionId, 'alpha\nbeta\n')

  const result = handleRead(manager, {
    action: 'read',
    cursor: 999,
    maxBytes: 4096,
    maxLineChars: 240,
    maxLines: 80,
    mode: 'full',
    previewBytes: 2000,
    sessionId: session.sessionId,
  })

  assert.equal(result.mode, 'full')
  assert.equal(result.compressed, false)
  assert.equal(result.text, 'alpha\nbeta')
  assert.equal(result.fromCursor, 0)
  assert.equal(result.toCursor, Buffer.byteLength('alpha\nbeta', 'utf8'))
  assert.equal(result.originalBytes, Buffer.byteLength('alpha\nbeta', 'utf8'))
  assert.equal(result.returnedBytes, Buffer.byteLength('alpha\nbeta', 'utf8'))
})

test('handleRead save_file writes full visible snapshot and returns compact preview', () => {
  const manager = new PtySessionManager({
    driver: new FakePtyDriver(),
  })
  const session = manager.open({ cwd: '/tmp/project', cols: 120, rows: 24 })
  const fullText = [
    'start',
    ...Array.from({ length: 6 }, () => 'repeat'),
    'end',
  ].join('\n')
  manager.write(session.sessionId, `${fullText}\n`)

  const result = handleRead(manager, {
    action: 'read',
    cursor: 0,
    maxBytes: 8192,
    maxLineChars: 240,
    maxLines: 80,
    mode: 'save_file',
    previewBytes: 2000,
    sessionId: session.sessionId,
  })

  assert.equal(result.mode, 'save_file')
  assert.equal(typeof result.filePath, 'string')
  assert.ok(existsSync(result.filePath))
  assert.equal(readFileSync(result.filePath, 'utf8'), fullText)
  assert.match(result.preview, /\[\.\.\. repeated \d+ more times \.\.\.\]/)
  assert.equal(result.originalBytes, Buffer.byteLength(fullText, 'utf8'))
  assert.equal(result.previewBytes, Buffer.byteLength(result.preview, 'utf8'))
})

test('handleRead returns a screen snapshot and ignores the requested cursor', () => {
  const manager = new PtySessionManager({
    driver: new FakePtyDriver(),
  })
  const session = manager.open({ cwd: '/tmp/project', cols: 40, rows: 6 })

  manager.write(session.sessionId, 'alpha\nbeta\n')

  const result = handleRead(manager, {
    action: 'read',
    cursor: 999,
    maxBytes: 4096,
    sessionId: session.sessionId,
  })

  assert.equal(result.fromCursor, 0)
  assert.equal(result.toCursor, Buffer.byteLength('alpha\nbeta', 'utf8'))
  assert.equal(result.text, 'alpha\nbeta')
  assert.equal(result.truncatedBeforeCursor, false)
})
