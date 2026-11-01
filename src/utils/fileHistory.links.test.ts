import { afterAll, expect, test } from 'bun:test'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UUID } from 'crypto'

const temp = mkdtempSync(join(tmpdir(), 'cc-file-history-links-'))
afterAll(() => rmSync(temp, { recursive: true, force: true }))
process.env.CLAUDE_CONFIG_DIR = join(temp, 'config')
process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1'

const { getSessionId } = await import('../bootstrap/state.js')
const { fileHistoryRewind } = await import('./fileHistory.js')

const messageId = '00000000-0000-4000-8000-000000000001' as UUID

function rewindTo(files: Record<string, string | null>) {
  const backupDir = join(temp, 'config', 'file-history', getSessionId())
  mkdirSync(backupDir, { recursive: true })
  const trackedFileBackups: Record<string, { backupFileName: string | null; version: number; backupTime: Date }> = {}
  for (const [path, content] of Object.entries(files)) {
    const backupFileName = content === null ? null : `${Buffer.from(path).toString('hex').slice(-16)}@v1`
    if (backupFileName) writeFileSync(join(backupDir, backupFileName), content!)
    trackedFileBackups[path] = { backupFileName, version: 1, backupTime: new Date() }
  }
  let state = {
    snapshots: [{ messageId, trackedFileBackups, timestamp: new Date() }],
    trackedFiles: new Set(Object.keys(files)),
    snapshotSequence: 1,
  }
  return fileHistoryRewind(updater => { state = updater(state as never) as never }, messageId)
}

test('rewind refuses to write or delete through symlinks and hard links', async () => {
  const outside = join(temp, 'outside.txt')
  writeFileSync(outside, 'outside')
  const symlinked = join(temp, 'symlinked.txt')
  symlinkSync(outside, symlinked)
  const hardlinked = join(temp, 'hardlinked.txt')
  linkSync(outside, hardlinked)
  const created = join(temp, 'created.txt')
  symlinkSync(outside, created)
  const plain = join(temp, 'plain.txt')
  writeFileSync(plain, 'edited')

  const result = await rewindTo({
    [symlinked]: 'restored',
    [hardlinked]: 'restored',
    [created]: null,
    [plain]: 'original',
  })

  expect(readFileSync(outside, 'utf8')).toBe('outside')
  expect(readFileSync(created, 'utf8')).toBe('outside')
  expect(readFileSync(plain, 'utf8')).toBe('original')
  expect(result?.skippedLinks).toBe(3)
})
