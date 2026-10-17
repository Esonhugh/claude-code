import { expect, mock, test } from 'bun:test'

const childFlag = 'CLAUDE_CODE_STATUS_SESSION_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('status session properties (isolated)', async () => {
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
        env: {
          ...process.env,
          [childFlag]: '1',
          CLAUDE_CODE_SESSION_KIND: 'bg',
        },
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
  Object.defineProperty(globalThis, 'MACRO', {
    configurable: true,
    value: { VERSION: 'test' },
  })
  let endpoint: string | null = '/tmp/cc-socks/status test.sock'
  mock.module('../../utils/udsMessaging.js', () => ({
    getUdsMessagingSocketPath: () => endpoint,
  }))

  const { buildPrimarySection } = await import('./Status.js')

  test('shows session kind and formatted listening peer address after Session ID', () => {
    const properties = buildPrimarySection()
    const sessionIdIndex = properties.findIndex(property => property.label === 'Session ID')

    expect(properties.slice(sessionIdIndex + 1, sessionIdIndex + 3)).toEqual([
      { label: 'Session kind', value: 'bg' },
      { label: 'Peer address', value: 'uds:/tmp/cc-socks/status%20test.sock' },
    ])
  })

  test('shows unavailable when no peer socket is listening', () => {
    endpoint = null
    const properties = buildPrimarySection()

    expect(properties.find(property => property.label === 'Peer address')).toEqual({
      label: 'Peer address',
      value: 'Not available',
    })
  })
}
