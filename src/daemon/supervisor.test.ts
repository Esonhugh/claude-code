import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { join } from 'path'
import { readFrames, writeFrame } from './protocol.js'

// The supervisor ends with process.exit, so it runs in a child process.
test('supervisor idle-exits after a watched worker ends', async () => {
  const config = mkdtempSync('/tmp/cc-sup-')
  const jobDir = join(config, 'jobs', 'abcd1234')
  mkdirSync(jobDir, { recursive: true })
  const ptySock = join(config, 'host.sock')
  const now = new Date().toISOString()
  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({
      id: 'abcd1234',
      sessionId: 'abcd1234-0000-4000-8000-000000000000',
      name: 'test',
      intent: '',
      cwd: config,
      args: [],
      state: 'running',
      ptySock,
      createdAt: now,
      updatedAt: now,
    }),
  )
  // A PTY host whose worker exits right after the supervisor starts watching.
  const host = createServer(socket => {
    readFrames(socket, frame => {
      if ((frame as { type: string }).type !== 'watch') return
      setTimeout(() => {
        writeFrame(socket, { type: 'exit', state: 'exited' })
        socket.end()
      }, 200)
    })
  })
  await new Promise<void>(resolve => host.listen(ptySock, resolve))

  const supervisor = Bun.spawn(
    [
      process.execPath,
      '-e',
      `globalThis.MACRO = { VERSION: 'test' }; await (await import(${JSON.stringify(join(import.meta.dir, 'supervisor.ts'))})).runSupervisor()`,
    ],
    { env: { ...process.env, CLAUDE_CONFIG_DIR: config }, stdout: 'ignore', stderr: 'pipe' },
  )
  const timeout = setTimeout(() => supervisor.kill('SIGKILL'), 12_000)
  const code = await supervisor.exited
  clearTimeout(timeout)
  host.close()

  const log = readFileSync(join(config, 'daemon.log'), 'utf8')
  expect(log).toContain('[bg] adopted abcd1234')
  expect(log).toContain('[bg] abcd1234 ended')
  expect(log).toContain('[supervisor] exit')
  expect(code).toBe(0)
}, 20_000)
