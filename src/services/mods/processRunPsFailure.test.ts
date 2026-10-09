import { expect, spyOn, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import * as exec from '../../utils/execFileNoThrow.js'
import { createModHostOperations } from './hostOperations.js'

for (const recovers of [false, true]) test(`an actual nonzero ps helper ${recovers ? 'followed by a recovered identity query' : 'on every query'} cannot leave the owned TERM-ignoring run waiting indefinitely`, async () => {
  const evidence = process.env.BROKER_TEST_EVIDENCE_DIR
  if (evidence) await mkdir(evidence, { recursive: true })
  const root = await realpath(await mkdtemp(join(evidence ?? tmpdir(), 'mods-run-ps-fault-')))
  const controller = new AbortController()
  const ps = join(root, 'ps')
  await writeFile(ps, `#!/bin/sh\nprintf 'ps failed\\n' >> '${join(root, 'ps-invoked')}'\nexit 1\n`)
  await chmod(ps, 0o700)
  const original = exec.execFileNoThrowWithCwd
  let identityQueries = 0
  // Keep the production helper unchanged; inject an actual owned helper's exit receipt.
  const run = spyOn(exec, 'execFileNoThrowWithCwd').mockImplementation((file, args, options) => {
    if (file !== 'ps') return original(file, args, options)
    if (recovers && !args.includes('lstart=')) return original(file, args, options)
    if (recovers && identityQueries++ > 0) return original(file, args, options).then(async result => {
      await writeFile(join(root, 'recovered-ps.json'), JSON.stringify(result))
      return result
    })
    return new Promise(resolve => {
      const child = spawn(ps, args, { cwd: options?.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.once('error', error => resolve({ stdout, stderr, code: 1, error: error.message }))
      child.once('close', code => resolve({ stdout, stderr, code: code ?? 1 }))
    })
  })
  let pid: number | undefined
  let pending: Promise<unknown> | undefined
  try {
    const preflight = await exec.execFileNoThrowWithCwd('ps', ['-o', 'pid=', '-o', 'lstart=', '-p', String(process.pid)], { cwd: '/', timeout: 500 })
    await writeFile(join(root, 'preflight.json'), JSON.stringify(preflight))
    expect(preflight).toEqual({ code: 1, stdout: '', stderr: '' })
    expect(await readFile(join(root, 'ps-invoked'), 'utf8')).toContain('ps failed')
    identityQueries = 0
    const host = createModHostOperations({ cwd: () => root, storageId: 'ps-fault@fixture', signal: controller.signal })
    let settled = false
    pending = host.process.run([process.execPath, '-e', `import {writeFileSync,renameSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync('ready.tmp',String(process.pid));renameSync('ready.tmp','ready');setInterval(()=>{},1000)`], { timeoutMs: 5000 })
      .then(value => { settled = true; return { kind: 'resolved', value } }, error => { settled = true; return { kind: 'rejected', error } })
    const readyDeadline = performance.now() + 3000
    while (!pid) {
      pid = await readFile(join(root, 'ready'), 'utf8').then(Number, () => undefined)
      if (performance.now() > readyDeadline) throw Error('Owned child did not start')
      if (!pid) await delay(5)
    }
    controller.abort(false)
    const deadline = performance.now() + 3500
    while (!settled && performance.now() < deadline) await delay(5)
    if (recovers) {
      const recovered = JSON.parse(await readFile(join(root, 'recovered-ps.json'), 'utf8'))
      expect(recovered.code).toBe(0)
      expect(recovered.stdout).toMatch(new RegExp(`^\\s*${pid}\\s+`, 'm'))
    }
    expect(settled).toBe(true)
    expect(await pending).toEqual({ kind: 'rejected', error: false })
    let exitProbeError: unknown
    try { process.kill(pid!, 0) } catch (error) { exitProbeError = error }
    expect(exitProbeError).toMatchObject({ code: 'ESRCH' })
  } finally {
    controller.abort()
    if (pid) { try { process.kill(-pid, 'SIGKILL') } catch { /* The owned child may already have exited. */ } }
    await pending
    run.mockRestore()
    if (!evidence) await rm(root, { recursive: true, force: true })
  }
}, 10000)


test('an actual failed second identity query cannot turn a surviving descendant into successful tree cleanup', async () => {
  const evidence = process.env.BROKER_TEST_EVIDENCE_DIR
  if (evidence) await mkdir(evidence, { recursive: true })
  const root = await realpath(await mkdtemp(join(evidence ?? tmpdir(), 'mods-run-descendant-ps-fault-')))
  const controller = new AbortController()
  const ps = join(root, 'ps')
  await writeFile(ps, `#!/bin/sh\nprintf 'second ps failed\\n' >> '${join(root, 'ps-invoked')}'\nexit 1\n`)
  await chmod(ps, 0o700)
  const original = exec.execFileNoThrowWithCwd
  let identityQueries = 0
  const run = spyOn(exec, 'execFileNoThrowWithCwd').mockImplementation((file, args, options) => {
    if (file !== 'ps' || !args.includes('lstart=')) return original(file, args, options)
    if (identityQueries++ === 0) return original(file, args, options).then(async result => {
      await writeFile(join(root, 'initial-ps.json'), JSON.stringify(result))
      return result
    })
    return new Promise(resolve => {
      const child = spawn(ps, args, { cwd: options?.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.once('error', error => resolve({ stdout, stderr, code: 1, error: error.message }))
      child.once('close', async code => {
        const result = { stdout, stderr, code: code ?? 1 }
        await writeFile(join(root, 'failed-ps.json'), JSON.stringify(result))
        resolve(result)
      })
    })
  })
  let pid: number | undefined, descendantPid: number | undefined
  let descendantGone = false
  let supervisorProbeErrorCode: string | undefined
  let pending: Promise<unknown> | undefined
  try {
    const descendant = `import {writeFileSync,renameSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync('descendant-ready.tmp',String(process.pid));renameSync('descendant-ready.tmp','descendant-ready');setInterval(()=>{},1000)`
    const parent = `import {spawn} from 'node:child_process';import {writeFileSync,renameSync} from 'node:fs';process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2]});writeFileSync('ready.tmp',String(process.pid));renameSync('ready.tmp','ready');setInterval(()=>{},1000)`
    const host = createModHostOperations({ cwd: () => root, storageId: 'descendant-ps-fault@fixture', signal: controller.signal })
    let settled = false
    pending = host.process.run([process.execPath, '-e', parent], { timeoutMs: 5000 })
      .then(value => { settled = true; return { kind: 'resolved', value } }, error => { settled = true; return { kind: 'rejected', error } })
    const readyDeadline = performance.now() + 3000
    while (!pid || !descendantPid) {
      pid = await readFile(join(root, 'ready'), 'utf8').then(Number, () => undefined)
      descendantPid = await readFile(join(root, 'descendant-ready'), 'utf8').then(Number, () => undefined)
      if (performance.now() > readyDeadline) throw Error('Owned parent and descendant did not start')
      if (!pid || !descendantPid) await delay(5)
    }
    controller.abort(false)
    const deadline = performance.now() + 3500
    while (!settled && performance.now() < deadline) await delay(5)
    const initial = JSON.parse(await readFile(join(root, 'initial-ps.json'), 'utf8'))
    expect(initial.code).toBe(0)
    for (const target of [pid, descendantPid]) expect(initial.stdout).toMatch(new RegExp(`^\\s*${target}\\s+`, 'm'))
    expect(JSON.parse(await readFile(join(root, 'failed-ps.json'), 'utf8'))).toEqual({ code: 1, stdout: '', stderr: '' })
    expect(await readFile(join(root, 'ps-invoked'), 'utf8')).toContain('second ps failed')
    expect(settled).toBe(true)
    const outcome = await pending as { kind: string; error: unknown }
    expect(outcome.kind).toBe('rejected')
    const descendantStillPresent = process.kill(descendantPid, 0)
    await writeFile(join(root, 'state-at-settlement.json'), JSON.stringify({ pid, descendantPid, descendantStillPresent, kind: outcome.kind, rawFalse: outcome.error === false }))
    expect(descendantStillPresent).toBe(true)
    expect(outcome.error).toBeInstanceOf(AggregateError)
    expect((outcome.error as AggregateError).errors[0]).toBe(false)
  } finally {
    controller.abort()
    if (pid) { try { process.kill(-pid, 'SIGKILL') } catch { /* Only the published owned group is reclaimed. */ } }
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL') } catch { /* The owned descendant may already have exited. */ } }
    await pending
    if (descendantPid) {
      const deadline = performance.now() + 1000
      for (;;) {
        try { process.kill(descendantPid, 0) } catch (error) {
          supervisorProbeErrorCode = (error as NodeJS.ErrnoException).code
          descendantGone = supervisorProbeErrorCode === 'ESRCH'
          break
        }
        if (performance.now() > deadline) break
        await delay(5)
      }
    }
    await writeFile(join(root, 'supervisor-cleanup.json'), JSON.stringify({ pid, descendantPid, descendantGone, supervisorProbeErrorCode }))
    run.mockRestore()
    if (!evidence) await rm(root, { recursive: true, force: true })
  }
  expect(descendantGone).toBe(true)
}, 10000)
