import { expect, test } from 'bun:test'

async function identityFixture(platform: 'linux' | 'darwin' | 'win32', scenario: string, ffiScenario = '') {
  const script = `
    import { mock } from 'bun:test'
    import * as fs from 'fs/promises'
    import * as os from 'node:os'
    import * as module from 'node:module'
    const calls = []
    const files = new Map()
    let namespace = 'pid:[4026531836]'
    const platform = ${JSON.stringify(platform)}
    let spawnOutput = platform === 'win32' ? '639249059612345678\\n' : 'Sat Sep 12 15:07:13 2026\\n'
    let ffiUnavailable = false
    let openFails = false
    let timesFail = false
    let timesThrow = false
    const creationTime = 134337827612345678n
    const debug = []
    ${ffiScenario}
    mock.module('node:os', () => ({ ...os, hostname: () => 'WORKSTATION-X64' }))
    mock.module(${JSON.stringify(import.meta.dir + '/debug.js')}, () => ({ logForDebugging: message => debug.push(message) }))
    const ffi = { dlopen: (name, definitions) => {
      calls.push(['dlopen', name, definitions])
      if (ffiUnavailable) throw new Error('FFI unavailable')
      return { symbols: {
        OpenProcess: (...args) => { calls.push(['OpenProcess', ...args]); return openFails ? 0 : 42 },
        GetProcessTimes: (handle, creation, exit, kernel, user) => {
          calls.push(['GetProcessTimes', handle, creation.byteLength, exit.byteLength, kernel.byteLength, user.byteLength])
          if (timesThrow) throw new Error('process disappeared')
          if (timesFail) return 0
          new DataView(creation.buffer).setBigUint64(0, creationTime, true)
          return 1
        },
        CloseHandle: handle => { calls.push(['CloseHandle', handle]); return 1 },
      } }
    } }
    mock.module('node:module', () => ({ ...module, createRequire: () => name => {
      if (name !== 'bun:ffi') throw new Error('unexpected module: ' + name)
      return ffi
    } }))
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
        return { code: 0, stdout: spawnOutput, stderr: '' }
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

test('Windows PID domain uses the lowercase hostname', async () => {
  const result = await identityFixture('win32', `
    console.log(JSON.stringify({ domain: await identity.getProcessPidDomain() }))
  `)
  expect(result.domain).toBe('win32:workstation-x64')
})

test('Windows process identity preserves FILETIME precision and closes every handle', async () => {
  const result = await identityFixture('win32', `
    const start = await identity.getProcessStart(123)
    const key = await identity.getProcessStartMetadata(123)
    console.log(JSON.stringify({ start, key, calls }))
  `)
  expect(result.start).toBe('134337827612345678')
  expect(result.key).toEqual({ procStartFt: '134337827612345678' })
  expect(result.calls.filter((call: unknown[]) => call[0] === 'dlopen')).toHaveLength(1)
  expect(result.calls.filter((call: unknown[]) => call[0] === 'OpenProcess')).toEqual([
    ['OpenProcess', 4096, 0, 123], ['OpenProcess', 4096, 0, 123],
  ])
  expect(result.calls.filter((call: unknown[]) => call[0] === 'GetProcessTimes')).toEqual([
    ['GetProcessTimes', 42, 8, 8, 8, 8], ['GetProcessTimes', 42, 8, 8, 8, 8],
  ])
  expect(result.calls.filter((call: unknown[]) => call[0] === 'CloseHandle')).toEqual([
    ['CloseHandle', 42], ['CloseHandle', 42],
  ])
  expect(result.calls.some((call: unknown[]) => call[0] === 'ps')).toBe(false)
})

test('Windows individual process failures never fall back to another time format', async () => {
  const result = await identityFixture('win32', `
    const invalid = await Promise.all([0, 1, -1, 1.5, 4294967296].map(identity.getProcessStart))
    openFails = true
    const denied = await identity.getProcessStart(123)
    openFails = false
    timesFail = true
    const gone = await identity.getProcessStart(123)
    timesFail = false
    timesThrow = true
    const thrown = await identity.getProcessStart(123)
    console.log(JSON.stringify({ invalid, denied: denied ?? null, gone: gone ?? null, thrown: thrown ?? null, calls }))
  `)
  expect(result.invalid).toEqual([null, null, null, null, null])
  expect(result.denied).toBeNull()
  expect(result.gone).toBeNull()
  expect(result.thrown).toBeNull()
  expect(result.calls.filter((call: unknown[]) => call[0] === 'OpenProcess')).toHaveLength(3)
  expect(result.calls.filter((call: unknown[]) => call[0] === 'CloseHandle')).toHaveLength(2)
  expect(result.calls.some((call: unknown[]) => call[0] === 'ps')).toBe(false)
})

test('Windows unavailable FFI uses bounded PowerShell ticks with procStart metadata', async () => {
  const result = await identityFixture('win32', `
    const key = await identity.getProcessStartMetadata(123)
    spawnOutput = 'malformed ticks'
    const malformed = await identity.getProcessStart(123)
    console.log(JSON.stringify({ key, malformed: malformed ?? null, calls, debug }))
  `, 'ffiUnavailable = true')
  expect(result.key).toEqual({ procStart: '639249059612345678' })
  expect(result.malformed).toBeNull()
  expect(result.calls.filter((call: unknown[]) => call[0] === 'dlopen')).toHaveLength(1)
  expect(result.calls.filter((call: unknown[]) => call[0] === 'ps')).toEqual([
    ['ps', 'powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId=123").CreationDate.Ticks'], { timeout: 1000 }],
    ['ps', 'powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId=123").CreationDate.Ticks'], { timeout: 1000 }],
  ])
  expect(result.debug.some((line: string) => line.includes('falling back'))).toBe(true)
})

test('Windows auth metadata compares only the active process time format', async () => {
  const result = await identityFixture('win32', `
    const valid = await identity.isProcessStartMatching(123, { procStartFt: creationTime.toString() })
    const stale = await identity.isProcessStartMatching(123, { procStartFt: '134337827612345679' })
    const otherFormat = await identity.isProcessStartMatching(123, { procStart: '639249059612345678' })
    console.log(JSON.stringify({ valid, stale, otherFormat, calls }))
  `)
  expect(result.valid).toBe(true)
  expect(result.stale).toBe(false)
  expect(result.otherFormat).toBe(true)
  expect(result.calls.filter((call: unknown[]) => call[0] === 'OpenProcess')).toHaveLength(2)
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
