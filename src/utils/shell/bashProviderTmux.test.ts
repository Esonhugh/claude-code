import { afterAll, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}
const { createBashShellProvider } = await import('./bashProvider.js')

const root = mkdtempSync(join(tmpdir(), 'bash-tmux-isolation-'))
const saved = {
  HOME: process.env.HOME,
  TMUX: process.env.TMUX,
  TMUX_TMPDIR: process.env.TMUX_TMPDIR,
}
const userSocket = join(root, 'user.sock')
let claudeSocket: string | undefined

afterAll(() => {
  for (const socket of [userSocket, claudeSocket]) {
    if (socket) {
      spawnSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' })
    }
  }
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

test.skipIf(!Bun.which('tmux'))(
  "Bash tmux commands use Claude's own tmux server and config, not the user's",
  async () => {
    // A user tmux.conf that changes behavior, and an outer tmux session.
    writeFileSync(join(root, '.tmux.conf'), 'set -g base-index 7\n')
    process.env.HOME = root
    process.env.TMUX_TMPDIR = root
    execFileSync('tmux', ['-f', '/dev/null', '-S', userSocket, 'new-session', '-d', '-s', 'usersess'])
    process.env.TMUX = `${userSocket},1,0`

    const provider = await createBashShellProvider('/bin/bash', { skipSnapshot: true })
    const env = await provider.getEnvironmentOverrides('tmux new-session -d -s work')

    expect(env.TMUX).toBeDefined()
    claudeSocket = env.TMUX!.split(',')[0]!
    expect(claudeSocket).not.toBe(userSocket)
    expect(claudeSocket).toContain(`claude-${process.pid}`)

    const sessions = execFileSync('tmux', ['-S', claudeSocket, 'list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
    })
    expect(sessions).not.toContain('usersess')
    const baseIndex = execFileSync('tmux', ['-S', claudeSocket, 'show-options', '-gv', 'base-index'], {
      encoding: 'utf8',
    })
    expect(baseIndex.trim()).toBe('0')
  },
)
