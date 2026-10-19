import { expect, test } from 'bun:test'

async function journalFixture(platform: 'linux' | 'darwin' | 'win32', env: Record<string, string>) {
  const script = `
    import { mock } from 'bun:test'
    import * as module from 'node:module'
    const calls = []
    const ffi = { dlopen: (path, definitions) => {
      calls.push(['dlopen', path, Object.keys(definitions)])
      return { symbols: { cc_terminal_journal_mark: (kind, spanId, payload, length) => {
        calls.push(['mark', kind, spanId, length])
        return 1
      } } }
    } }
    mock.module('node:module', () => ({ ...module, createRequire: () => name => {
      if (name !== 'bun:ffi') throw new Error('unexpected module: ' + name)
      return ffi
    } }))
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} })
    const journal = await import(${JSON.stringify(import.meta.dir + '/nativeTerminalJournal.ts')})
    journal.initializeNativeTerminalJournal()
    journal.beginNativeTerminalFrame(1, 2, 80, 24)
    console.log(JSON.stringify(calls))
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH, LANG: 'C', TZ: 'UTC', ...env },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect(stderr).toBe('')
  expect(exitCode).toBe(0)
  return JSON.parse(stdout)
}

const captureEnv = {
  CLAUDE_PRIVATE_NATIVE_JOURNAL: '1',
  CLAUDE_PRIVATE_NATIVE_JOURNAL_LIBRARY: '/run/capture/observer.so',
}

for (const platform of ['linux', 'darwin'] as const) {
  test(`${platform} loads the enrolled marker library only under native capture`, async () => {
    const enrolled = await journalFixture(platform, captureEnv)
    expect(enrolled[0]).toEqual(['dlopen', '/run/capture/observer.so', ['cc_terminal_journal_mark']])
    expect(enrolled[1].slice(0, 3)).toEqual(['mark', 10, 1])
    expect(enrolled).toHaveLength(2)

    expect(await journalFixture(platform, {})).toEqual([])
    expect(await journalFixture(platform, { CLAUDE_PRIVATE_NATIVE_JOURNAL: '1' })).toEqual([])
  })
}

test('other platforms never load the marker library', async () => {
  expect(await journalFixture('win32', captureEnv)).toEqual([])
})
