import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scrubSecrets } from './secrets'

test('files holding a known value or a key-shaped string are replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-secrets-'))
  fs.mkdirSync(path.join(dir, 'w'))
  fs.writeFileSync(path.join(dir, 'clean.jsonl'), '{"usage":{"input_tokens":3}}\n')
  fs.writeFileSync(path.join(dir, 'w', 'leak.txt'), 'token=opaque-value-0123456789abcdef')
  fs.writeFileSync(path.join(dir, 'err.txt'), `Authorization: x-api-key sk-ant-api03-${'a'.repeat(40)}`)
  const hits = scrubSecrets(dir, ['opaque-value-0123456789abcdef']).sort()
  expect(hits).toEqual(['err.txt', path.join('w', 'leak.txt')])
  expect(fs.readFileSync(path.join(dir, 'err.txt'), 'utf8')).not.toContain('sk-ant')
  expect(fs.readFileSync(path.join(dir, 'clean.jsonl'), 'utf8')).toContain('input_tokens')
  fs.rmSync(dir, { recursive: true })
})
