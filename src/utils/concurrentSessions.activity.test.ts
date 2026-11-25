import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { runCleanupFunctions } from './cleanupRegistry.js'
import { derivedSessionName, getRegisteredSessionName, registerSession, updateSessionActivity } from './concurrentSessions.js'

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

test('interactive sessions not named at launch get the official derived name', async () => {
  const oldName = process.env.CLAUDE_CODE_SESSION_NAME
  delete process.env.CLAUDE_CODE_SESSION_NAME
  try {
    expect(derivedSessionName('/work/My Project.v2')).toMatch(/^my-project-v2-[0-9a-f]{2}$/)
    expect(derivedSessionName('/work/项目')).toMatch(/^claude-[0-9a-f]{2}$/)
    expect(await registerSession()).toBe(true)
    expect(getRegisteredSessionName()).toMatch(/^[a-z0-9-]+-[0-9a-f]{2}$/)
    process.env.CLAUDE_CODE_SESSION_NAME = 'worker'
    await runCleanupFunctions()
    expect(await registerSession()).toBe(true)
    expect(getRegisteredSessionName()).toBe('worker')
  } finally {
    if (oldName === undefined) delete process.env.CLAUDE_CODE_SESSION_NAME
    else process.env.CLAUDE_CODE_SESSION_NAME = oldName
  }
})
