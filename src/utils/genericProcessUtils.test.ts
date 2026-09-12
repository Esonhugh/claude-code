import { expect, test } from 'bun:test'

async function identityFixture(platform: 'linux' | 'darwin', scenario: string) {
  const script = `
    import { mock } from 'bun:test'
    import * as fs from 'fs/promises'
    const calls = []
    const files = new Map()
    let namespace = 'pid:[4026531836]'
    const platform = ${JSON.stringify(platform)}
    mock.module('fs/promises', () => ({
      ...fs,
      readFile: async path => {
        calls.push(['readFile', path])
        if (!files.has(path)) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' })
        return files.get(path)
      },
      readlink: async path => {
        calls.push(['readlink', path])
        if (namespace === undefined) throw Object.assign(new Error('unavailable'), { code: 'EACCES' })
        return namespace
      },
    }))
    mock.module(${JSON.stringify(import.meta.dir + '/execFileNoThrow.js')}, () => ({
      execFileNoThrowWithCwd: async (...args) => {
        calls.push(['ps', ...args])
        return { code: 0, stdout: 'Sat Sep 12 15:07:13 2026\\n', stderr: '' }
      },
      execSyncWithDefaults_DEPRECATED: () => '',
    }))
    Object.defineProperty(process, 'platform', { value: platform })
    const identity = await import(${JSON.stringify(import.meta.dir + '/genericProcessUtils.ts')})
    ${scenario}
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH, LANG: 'C', TZ: 'UTC' },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect(stderr).toBe('')
  expect(exitCode).toBe(0)
  return JSON.parse(stdout)
}

test('Linux process start uses kernel stat field 22, not ps wall-clock time', async () => {
  const result = await identityFixture('linux', `
    files.set('/proc/123/stat', '123 (worker ) with spaces) S ' + Array(18).fill('0').join(' ') + ' 344439141 99\\n')
    console.log(JSON.stringify({ start: await identity.getProcessStart(123), calls }))
  `)
  expect(result.start).toBe('344439141')
  expect(result.calls).toEqual([['readFile', '/proc/123/stat']])
})

test('Linux unavailable or malformed stat never falls back to a different identity format', async () => {
  const result = await identityFixture('linux', `
    files.set('/proc/123/stat', '123 (truncated) S 0')
    files.set('/proc/124/stat', '124 (worker) S ' + Array(18).fill('0').join(' ') + ' invalid')
    const starts = await Promise.all([0, 1, 1.5, 123, 124, 125].map(identity.getProcessStart))
    console.log(JSON.stringify({ starts, calls }))
  `)
  expect(result.starts).toEqual([null, null, null, null, null, null])
  expect(result.calls.every((call: string[]) => call[0] === 'readFile')).toBe(true)
})

test('Linux PID domain includes machine ID and PID namespace, not boot ID', async () => {
  const result = await identityFixture('linux', `
    files.set('/etc/machine-id', '4e7515a39d2c445abe260791d619d4f4\\n')
    console.log(JSON.stringify({ domain: await identity.getProcessPidDomain(), calls }))
  `)
  expect(result.domain).toBe('linux:4e7515a39d2c445abe260791d619d4f4:pid:[4026531836]')
  expect(result.calls).toEqual([
    ['readFile', '/etc/machine-id'], ['readlink', '/proc/self/ns/pid'],
  ])
})

test('Linux missing domain components use the official empty-component representation', async () => {
  const result = await identityFixture('linux', `
    namespace = undefined
    console.log(JSON.stringify({ domain: await identity.getProcessPidDomain() }))
  `)
  expect(result.domain).toBe('linux::')
})

test('Darwin keeps its ps start identity and platform domain', async () => {
  const result = await identityFixture('darwin', `
    console.log(JSON.stringify({ start: await identity.getProcessStart(123), domain: await identity.getProcessPidDomain(), calls }))
  `)
  expect(result.start).toBe('Sat Sep 12 15:07:13 2026')
  expect(result.domain).toBe('darwin')
  expect(result.calls).toEqual([
    ['ps', 'ps', ['-o', 'lstart=', '-p', '123'], { timeout: 1000, env: { LC_ALL: 'C', TZ: 'UTC' } }],
  ])
})
