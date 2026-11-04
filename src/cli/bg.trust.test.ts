import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'bg-trust-'))
const previousConfig = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')

const { getCwdState, getOriginalCwd, setCwdState, setOriginalCwd, setSessionTrustAccepted } = await import(
  '../bootstrap/state.js'
)
const { resetTrustDialogAcceptedCacheForTesting } = await import('../utils/config.js')
const protocol = await import('../daemon/protocol.js')
const { handleBgFlag } = await import('./bg.js')

const savedCwd = getCwdState()
const savedOriginalCwd = getOriginalCwd()

afterAll(() => {
  setCwdState(savedCwd)
  setOriginalCwd(savedOriginalCwd)
  resetTrustDialogAcceptedCacheForTesting()
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  rmSync(root, { recursive: true, force: true })
})

test('claude --bg refuses a workspace whose trust prompt was never accepted', async () => {
  const work = mkdtempSync(join(root, 'work-'))
  setOriginalCwd(work)
  setCwdState(work)
  setSessionTrustAccepted(false)
  resetTrustDialogAcceptedCacheForTesting()
  const err: string[] = []
  const stderr = spyOn(process.stderr, 'write').mockImplementation(chunk => (err.push(String(chunk)), true))
  const exit = spyOn(process, 'exit').mockImplementation(code => {
    throw new Error(`exit ${code}`)
  })
  const daemon = spyOn(protocol, 'ensureDaemon').mockImplementation(async () => {
    throw new Error('the background service must not start')
  })
  try {
    expect(await handleBgFlag('fix the build', ['--bg', 'fix the build']).catch(e => String(e))).toBe('Error: exit 1')
    expect(daemon).not.toHaveBeenCalled()
    expect(err.join('')).toContain('Workspace not trusted')
  } finally {
    stderr.mockRestore()
    exit.mockRestore()
    daemon.mockRestore()
  }
})
