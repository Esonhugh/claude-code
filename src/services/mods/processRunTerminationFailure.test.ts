import { expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import * as debug from '../../utils/debug.js'
import { createModHostOperations } from './hostOperations.js'

for (const allTargetsFail of [false, true]) test(allTargetsFail
  ? 'failure to signal every owned target rejects without inventing close for a live child'
  : 'group TERM failure still allows actual PID fallback and the child TERM handler', async () => {
  const evidence = process.env.BROKER_TEST_EVIDENCE_DIR
  if (evidence) await mkdir(evidence, { recursive: true })
  const root = await realpath(await mkdtemp(join(evidence ?? tmpdir(), 'mods-run-kill-fault-')))
  const controller = new AbortController()
  const host = createModHostOperations({ cwd: () => root, storageId: 'kill-fault@fixture', signal: controller.signal })
  const messages: string[] = []
  const log = spyOn(debug, 'logForDebugging').mockImplementation(message => { messages.push(message) })
  let settled = false
  const handler = allTargetsFail ? '' : "writeFileSync('terminated','TERM');process.exit(42)"
  const pending = host.process.run([process.execPath, '-e', `import {writeFileSync,renameSync} from 'node:fs';process.on('SIGTERM',()=>{${handler}});writeFileSync('ready.tmp',String(process.pid));renameSync('ready.tmp','ready');setInterval(()=>{},1000)`], { timeoutMs: 5000 })
    .then(value => { settled = true; return { kind: 'resolved', value } }, error => { settled = true; return { kind: 'rejected', error } })
  let pid: number | undefined
  const originalKill = process.kill.bind(process)
  let kill: ReturnType<typeof spyOn<typeof process, 'kill'>> | undefined
  const fault = Object.assign(new Error('owned signal failure'), { code: 'EPERM' })
  const attempts: { target: number; signal: unknown }[] = []
  let childGone = false
  let supervisorProbeErrorCode: string | undefined
  const receipts = () => messages.filter(message => message.startsWith('[ModsProcess] '))
    .map(message => JSON.parse(message.slice('[ModsProcess] '.length)))
  try {
    const readyDeadline = performance.now() + 3000
    while (!pid) {
      pid = await readFile(join(root, 'ready'), 'utf8').then(Number, () => undefined)
      if (performance.now() > readyDeadline) throw Error('Owned child did not start')
      if (!pid) await delay(5)
    }
    kill = spyOn(process, 'kill').mockImplementation((target, signal) => {
      attempts.push({ target, signal })
      if ((target === -pid! && signal === 'SIGTERM') ||
        (allTargetsFail && Math.abs(target) === pid && (signal === 'SIGTERM' || signal === 'SIGKILL'))) throw fault
      return originalKill(target, signal)
    })
    controller.abort(false)
    const deadline = performance.now() + 3500
    while (!settled && performance.now() < deadline) await delay(5)
    expect(settled).toBe(true)
    const outcome = await pending as { kind: string; error: unknown }
    expect(outcome.kind).toBe('rejected')
    expect(attempts).toContainEqual({ target: pid!, signal: 'SIGTERM' })
    if (allTargetsFail) {
      expect(attempts).toContainEqual({ target: pid!, signal: 'SIGKILL' })
      expect(outcome.error).toBeInstanceOf(AggregateError)
      const error = outcome.error as AggregateError
      expect(error.message).toBe('Process tree termination failed')
      expect(error.errors).toEqual([false, fault])
      expect(originalKill(pid!, 0)).toBe(true)
      expect(receipts().filter(row => row.phase === 'close')).toHaveLength(0)
    } else {
      expect(outcome.error).toBe(false)
      expect(await readFile(join(root, 'terminated'), 'utf8')).toBe('TERM')
      let exitProbeError: unknown
      try { originalKill(pid!, 0) } catch (error) { exitProbeError = error }
      expect(exitProbeError).toMatchObject({ code: 'ESRCH' })
      expect(receipts().filter(row => row.phase === 'close')).toHaveLength(1)
      expect(receipts().find(row => row.phase === 'close')).toMatchObject({ exitCode: 42, stopped: true })
    }
  } finally {
    kill?.mockRestore()
    controller.abort()
    if (pid) { try { originalKill(-pid, 'SIGKILL') } catch { /* The owned child may already have exited. */ } }
    await pending
    if (pid) {
      const deadline = performance.now() + 1000
      for (;;) {
        try { originalKill(pid, 0) } catch (error) {
          supervisorProbeErrorCode = (error as NodeJS.ErrnoException).code
          childGone = supervisorProbeErrorCode === 'ESRCH'
          break
        }
        if (performance.now() > deadline) break
        await delay(5)
      }
    }
    await writeFile(join(root, 'supervisor-cleanup.json'), JSON.stringify({ pid, childGone, supervisorProbeErrorCode }))
    await writeFile(join(root, 'signal-attempts.json'), JSON.stringify(attempts))
    await writeFile(join(root, 'process-receipts.json'), JSON.stringify(receipts()))
    log.mockRestore()
    if (!evidence) await rm(root, { recursive: true, force: true })
  }
  expect(childGone).toBe(true)
}, 10000)
