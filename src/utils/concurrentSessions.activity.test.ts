import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { runCleanupFunctions } from './cleanupRegistry.js'
import { registerSession, updateSessionActivity } from './concurrentSessions.js'

let root: string
let oldConfig: string | undefined

beforeEach(async () => {
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  root = await mkdtemp('/tmp/cc-session-activity-')
  oldConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
})

afterEach(async () => {
  await runCleanupFunctions()
  if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = oldConfig
  await rm(root, { recursive: true, force: true })
})

const pidFile = () => join(root, 'sessions', `${process.pid}.json`)

test('activity reported before registration lands in the pid file', async () => {
  await updateSessionActivity({ status: 'idle' })
  expect(await registerSession()).toBe(true)
  expect(JSON.parse(await readFile(pidFile(), 'utf8'))).toMatchObject({ status: 'idle' })
})

test('activity reported while registration is in flight is not lost', async () => {
  const registered = registerSession()
  const update = updateSessionActivity({ status: 'busy' })
  expect(await registered).toBe(true)
  await update
  expect(JSON.parse(await readFile(pidFile(), 'utf8'))).toMatchObject({ status: 'busy' })
})
