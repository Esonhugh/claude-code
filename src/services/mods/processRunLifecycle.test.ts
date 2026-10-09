import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import * as debug from '../../utils/debug.js'
import { createModHostOperations } from './hostOperations.js'

const limit = 4 * 1024 * 1024
let root: string
let controller: AbortController
let host: ReturnType<typeof createModHostOperations>
let messages: string[]
let log: ReturnType<typeof spyOn<typeof debug, 'logForDebugging'>>
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mods-process-run-')))
  controller = new AbortController()
  host = createModHostOperations({ storageId: 'process-run@fixture', cwd: () => root, signal: controller.signal })
  messages = []
  log = spyOn(debug, 'logForDebugging').mockImplementation(message => { messages.push(message) })
})
afterEach(async () => {
  controller.abort()
  log.mockRestore()
  await rm(root, { recursive: true, force: true })
})
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const receipts = () => messages.filter(message => message.startsWith('[ModsProcess] '))
  .map(message => JSON.parse(message.slice('[ModsProcess] '.length)))
async function ready(file: string): Promise<number> {
  const deadline = performance.now() + 3000
  for (;;) {
    const pid = await readFile(file, 'utf8').then(Number, () => NaN)
    if (Number.isInteger(pid) && pid > 1) return pid
    if (performance.now() > deadline) throw Error('Real child did not publish its PID')
    await delay(5)
  }
}

test('real Git run receipts bind actual argv, PID, close and full stream bytes without printing contents', async () => {
  const executable = join(root, 'git')
  await writeFile(executable, `#!${process.execPath}\nimport {writeSync,writeFileSync} from 'node:fs';writeFileSync('pid',String(process.pid));writeSync(1,Buffer.alloc(${limit + 37},'o'));writeSync(2,'private stderr');process.exitCode=7\n`)
  await chmod(executable, 0o700)
  const argv = [executable, 'private argument']
  const result = await host.process.run(argv, { timeoutMs: 5000, env: { PRIVATE_TEST_VALUE: 'private environment' } })
  expect(result).toEqual({ exitCode: 7, stdout: 'o'.repeat(limit), stderr: 'private stderr', isStdoutTruncated: true, isStderrTruncated: false })
  const pid = Number(await readFile(join(root, 'pid'), 'utf8'))
  const rows = receipts()
  expect(rows.map(row => row.phase)).toEqual(['start', 'close'])
  const expectedArgs = ['-c', `core.hooksPath=${process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null'}`, ...argv.slice(1)]
  for (const row of rows) {
    expect(row).toMatchObject({ owner: 'process-run@fixture', pid, timeoutMs: 5000, argsSHA256: sha(JSON.stringify(expectedArgs)) })
    expect(row.operationId).toBe(rows[0].operationId)
    expect(typeof row.operationId).toBe('string')
  }
  expect(rows[1]).toMatchObject({ exitCode: 7, stopped: false, isStdoutTruncated: true, isStderrTruncated: false,
    stdoutBytes: limit + 37, stdoutRetainedBytes: limit, stdoutSHA256: sha(Buffer.alloc(limit + 37, 'o')),
    stderrBytes: Buffer.byteLength('private stderr'), stderrRetainedBytes: Buffer.byteLength('private stderr'), stderrSHA256: sha('private stderr') })
  expect(rows[1].elapsedMs).toBeGreaterThan(rows[0].elapsedMs)
  expect(rows[1].elapsedMs).toBeLessThan(5000)
  for (const forbidden of ['private argument', 'private environment', 'private stderr', executable])
    expect(JSON.stringify(rows)).not.toContain(forbidden)
})

test('exact cap with an incomplete but untruncated UTF-8 tail uses normal Buffer decoding', async () => {
  const result = await host.process.run([process.execPath, '-e', `import {writeSync} from 'node:fs';writeSync(1,Buffer.concat([Buffer.alloc(${limit - 1},'o'),Buffer.from([0xe4])]))`])
  expect(result.stdout).toBe('o'.repeat(limit - 1) + '�')
  expect(result.isStdoutTruncated).toBe(false)
  expect(result.isStderrTruncated).toBe(false)
})

for (const reason of [new Error('specific cancellation'), false, null, 0, '']) {
  test(`actual run preserves internal ${String(reason)} and allows the child to handle SIGTERM before close`, async () => {
    const file = join(root, 'ready')
    const script = `import {writeFileSync,renameSync} from 'node:fs';process.on('SIGTERM',()=>{writeFileSync('terminated','TERM');process.exit(42)});writeFileSync('ready.tmp',String(process.pid));renameSync('ready.tmp','ready');setInterval(()=>{},1000)`
    const pending = host.process.run([process.execPath, '-e', script], { timeoutMs: 5000 })
      .then(value => ({ kind: 'resolved', value }), error => ({ kind: 'rejected', error }))
    let pid: number | undefined
    try {
      pid = await ready(file)
      controller.abort(reason)
      const outcome = await pending
      expect(outcome).toEqual({ kind: 'rejected', error: reason })
      expect(await readFile(join(root, 'terminated'), 'utf8')).toBe('TERM')
      let exitProbeError: unknown
      try { process.kill(pid!, 0) } catch (error) { exitProbeError = error }
      expect(exitProbeError).toMatchObject({ code: 'ESRCH' })
      const rows = receipts()
      expect(rows.filter(row => row.phase === 'stop')).toHaveLength(1)
      expect(rows.filter(row => row.phase === 'close')).toHaveLength(1)
      expect(rows.find(row => row.phase === 'stop')).toMatchObject({ pid, cause: 'abort' })
      expect(rows.find(row => row.phase === 'close')).toMatchObject({ pid, exitCode: 42, stopped: true })
    } finally {
      controller.abort()
      await pending
      if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* The owned child may already have exited. */ } }
    }
  })
}

test('startup failure logs actual error and close without inventing a spawn receipt', async () => {
  await expect(host.process.run([join(root, 'missing')])).rejects.toMatchObject({ code: 'ENOENT' })
  const rows = receipts()
  expect(rows.filter(row => row.phase === 'start')).toHaveLength(0)
  expect(rows.filter(row => row.phase === 'error')).toHaveLength(1)
  expect(rows.filter(row => row.phase === 'close')).toHaveLength(1)
  expect(rows.find(row => row.phase === 'error')).toMatchObject({ errorCode: 'ENOENT' })
})
