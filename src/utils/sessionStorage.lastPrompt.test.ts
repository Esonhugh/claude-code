import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as state from '../bootstrap/state.js'
import { runCleanupFunctions } from './cleanupRegistry.js'
import { createUserMessage } from './messages.js'
import { formatPeerPrompt } from './peerProtocol.js'
import * as storage from './sessionStorage.js'

let root: string
let priorConfig: string | undefined
let priorPersistence: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'session-last-prompt-'))
  priorConfig = process.env.CLAUDE_CONFIG_DIR
  priorPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  state.resetStateForTests()
  state.setOriginalCwd(root)
  storage.resetProjectForTesting()
})
afterEach(async () => {
  storage.resetProjectForTesting()
  state.resetStateForTests()
  if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = priorConfig
  if (priorPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = priorPersistence
  await rm(root, { recursive: true, force: true })
})

test("a teammate's message delivered as a prompt does not become the session's last prompt", async () => {
  await storage.recordTranscript([createUserMessage({ content: 'build the report with a team' })])
  // -p hands a teammate's mailbox message to the lead as its next prompt.
  await storage.recordTranscript([
    createUserMessage({ content: formatPeerPrompt('<teammate-message teammate_id="helper">{"type":"shutdown_approved"}</teammate-message>', false, true) }),
  ])
  await runCleanupFunctions()

  const lastPrompts = (await readFile(storage.getTranscriptPath(), 'utf8'))
    .split('\n')
    .filter(line => line.includes('"type":"last-prompt"'))
    .map(line => (JSON.parse(line) as { lastPrompt: string }).lastPrompt)
  expect(lastPrompts.at(-1)).toBe('build the report with a team')
})
