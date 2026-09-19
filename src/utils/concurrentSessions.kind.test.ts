import { expect, test } from 'bun:test'

const childFlag = 'CLAUDE_CODE_SESSION_KIND_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('session kind resolution (isolated)', async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        'test',
        '--feature=BG_SESSIONS',
        '--timeout',
        '30000',
        import.meta.path,
      ],
      {
        cwd: import.meta.dir,
        env: { ...process.env, [childFlag]: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
  }, 30_000)
} else {
  const { getSessionKind } = await import('./concurrentSessions.js')

  test('defaults to interactive and accepts supported environment kinds', () => {
    const original = process.env.CLAUDE_CODE_SESSION_KIND
    try {
      delete process.env.CLAUDE_CODE_SESSION_KIND
      expect(getSessionKind()).toBe('interactive')

      process.env.CLAUDE_CODE_SESSION_KIND = 'daemon-worker'
      expect(getSessionKind()).toBe('daemon-worker')

      process.env.CLAUDE_CODE_SESSION_KIND = 'invalid'
      expect(getSessionKind()).toBe('interactive')
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CODE_SESSION_KIND
      else process.env.CLAUDE_CODE_SESSION_KIND = original
    }
  })
}
