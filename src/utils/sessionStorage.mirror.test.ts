import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as state from '../bootstrap/state.js'
import { createUserMessage } from './messages.js'
import * as storage from './sessionStorage.js'

let root: string
let priorConfig: string | undefined
let priorPersistence: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'session-mirror-'))
  priorConfig = process.env.CLAUDE_CONFIG_DIR
  priorPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  state.resetStateForTests()
  state.setOriginalCwd(root)
  storage.resetProjectForTesting()
})
afterEach(async () => {
  await storage.flushSessionStorage()
  storage.resetProjectForTesting()
  state.resetStateForTests()
  if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = priorConfig
  if (priorPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = priorPersistence
  await rm(root, { recursive: true, force: true })
})

test('a session mirror receives each batch written to the transcript file', async () => {
  const frames: { filePath: string; entries: { type: string; uuid?: string }[] }[] = []
  storage.addSessionMirror((filePath, entries) => frames.push({ filePath, entries: entries as never }))
  const message = createUserMessage({ content: 'mirror me' })
  await storage.recordTranscript([message])
  await storage.flushSessionStorage()

  const path = storage.getTranscriptPath()
  const mirrored = frames.filter(frame => frame.filePath === path).flatMap(frame => frame.entries)
  expect(mirrored.some(entry => entry.type === 'user' && entry.uuid === message.uuid)).toBe(true)
})
