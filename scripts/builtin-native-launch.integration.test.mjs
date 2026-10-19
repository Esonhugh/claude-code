import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readlinkSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { readNativeDriverClock } from './native-driver-clock.mjs'
import { recheckBuiltinSide } from './recheck-builtin-terminal-evidence.mjs'
import { startBuiltinRun, parseArgs, isIdlePrompt, cleanupAcceptanceSide } from './mods-test-lab.mjs'

const binary = process.env.BUILTIN_NATIVE_TEST_BINARY
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const selected = binary ? test : test.skip
const linux = process.platform === 'linux'

// This opt-in integration needs a freshly built binary. Keep its originals as evidence.
selected('builtin compiled launch uses native journal inside its existing sandbox', async () => {
  const root = mkdtempSync(linux ? '/tmp/bn-' : '/private/tmp/bn-')
  const cache = join(root, 'cache')
  mkdirSync(cache)
  let launch, cleanup, firstFailure
  const tmux = (args) => execFileSync(launch.tmux, ['-S', launch.socket, ...args],
    { env: launch.env, encoding: 'utf8', timeout: 10000 })
  const until = async (predicate, label) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (predicate()) return
      await delay(20)
    }
    throw Error('Timed out waiting for ' + label)
  }
  try {
    launch = startBuiltinRun(parseArgs(['run-builtin', '--binary', binary, '--cache', cache]), undefined, undefined, (run, env) => {
      env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'
      const path = join(run, 'config/.claude.json')
      const config = JSON.parse(readFileSync(path))
      writeFileSync(path, JSON.stringify({ ...config, projects: {
        [join(run, 'project')]: { hasTrustDialogAccepted: true },
      } }))
    })
    await until(() => isIdlePrompt(tmux(['capture-pane', '-p', '-t', launch.target])), 'actual idle prompt')
    expect(launch.capture.nativeJournal).toBe(true)
    expect(launch.capture.brokerPlacement).toBe('launcher-final-native-exec')
    expect(launch.capture.initialSize).toEqual({ columns: 160, rows: 50 })
    if (linux) expect([launch.argv[0], basename(launch.argv[1]), launch.argv[2], launch.argv[4]])
      .toEqual(['/usr/bin/python3', 'linux-sandbox-exec.py', '--policy', '--'])
    else expect(launch.argv[0]).toBe('/usr/bin/sandbox-exec')
    expect(launch.capture.observer).toBe(linux ? 'linux-seccomp-ptrace-v1' : undefined)
    expect(launch.argv).not.toContain('--plugin-dir')
    expect(launch.env.CLAUDE_CODE_BUILTIN_MODS_ARCHIVE).toBeUndefined()
    expect(hash(join(launch.run, 'bin/claude'))).toBe(hash(binary))
    const start = JSON.parse(readFileSync(join(launch.run, 'start.json')))
    expect(start.binarySha256).toBe(hash(binary))
    expect(Number.isSafeInteger(start.childPid)).toBe(true)
    expect(start.childPgid).toBe(start.childPid)
    const executable = linux ? readlinkSync(`/proc/${start.childPid}/exe`)
      : execFileSync('/bin/ps', ['-p', String(start.childPid), '-o', 'comm='], { encoding: 'utf8', timeout: 10000 }).trim()
    expect(executable).toBe(join(launch.run, 'bin/claude'))
    for (const name of ['journal.bin', 'registration.json', 'native-observer.json',
      'frames.jsonl', ...(linux ? ['observer.so', 'observer-exec'] : ['observer.dylib'])])
      expect(existsSync(join(launch.run, name))).toBe(true)
    const originPath = join(launch.run, 'native-normal-origin.json')
    expect(existsSync(originPath)).toBe(true)
    const origin = JSON.parse(readFileSync(originPath))
    expect(origin.driverPid).toBe(process.pid)
    expect(origin.captureId).toBe(launch.capture.captureId)
    expect(origin.rawOffset).toBe(0)
    expect(origin.measurements.origin_flag).toBe('0')
    expect(origin.measurements.pane_start_command).toBe(launch.capture.wrapper)
    const clock = readNativeDriverClock(launch)
    expect(clock.childPid).toBe(start.childPid)
    expect(clock.callerPid).toBe(process.pid)
    expect(typeof clock.tick).toBe('string')
    const helpers = JSON.parse(readFileSync(join(launch.run, 'native-broker/helpers.json')))
    for (const row of helpers.files) {
      expect(hash(join(launch.run, 'native-broker', row.name))).toBe(row.sha256)
      expect(hash(join(dirname(import.meta.path), row.name))).toBe(row.sha256)
    }
    expect(helpers.files.map(row => row.name)).toEqual([
      'terminal-evidence-broker.py', 'terminal-evidence-broker-native.py',
      'native-terminal-journal.py', 'native-live-publisher.py', 'verify-native-frame-journal.py',
    ])
  } catch (error) { firstFailure = error }
  finally {
    if (launch) {
      try {
        tmux(['send-keys', '-t', launch.target, '-l', '/exit'])
        tmux(['send-keys', '-t', launch.target, 'Enter'])
        await until(() => tmux(['display-message', '-p', '-t', launch.target, '#{pane_dead}']).trim() === '1', 'native normal exit')
      } catch (error) { firstFailure ??= error }
      cleanup = await cleanupAcceptanceSide(launch, { close: async () => {} })
    }
    writeFileSync(join(root, 'result.json'), JSON.stringify({ run: launch?.run,
      binarySHA256: hash(binary), nativeJournal: launch?.capture.nativeJournal,
      cleanup, error: firstFailure && String(firstFailure) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log('BUILTIN_NATIVE_LAUNCH_EVIDENCE=' + root)
  }
  if (firstFailure) throw firstFailure
  expect(existsSync(join(launch.run, 'producer-expected-native.json'))).toBe(true)
  expect(cleanup.verdict).toBe('passed')
  expect(cleanup.terminalCapture.boundedVerdict).toBe('passed')
  expect(cleanup.terminalCapture.fullNativeGatePassed).toBe(false)
  expect(cleanup.terminalCapture.productTimingEquivalent).toBe(false)
  const evidence = join(root, 'archive-evidence'), archive = join(evidence, 'acceptance-cache'),
    receipt = join(evidence, 'builtin-cache-archive.json')
  mkdirSync(evidence)
  const python = `import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('actual_archive_driver',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
module.archive_builtin_cache(Path(sys.argv[2]),Path(sys.argv[3]),Path(sys.argv[4]))`
  execFileSync('/usr/bin/env', ['python3', '-c', python,
    join(dirname(import.meta.dir), '.claude/skills/release-validation/scripts/run-binary-gate.py'),
    cache, archive, receipt], { env: launch.env, encoding: 'utf8', timeout: 60000 })
  const remap = value => {
    if (Array.isArray(value)) return value.map(remap)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]))
    return typeof value === 'string' && (value === cache || value.startsWith(cache + '/')) ? archive + value.slice(cache.length) : value
  }
  const side = remap({ run: launch.run, binarySha256: hash(binary), captureId: launch.capture.captureId,
    target: launch.target, pane: launch.pane, cleanup }), retained = join(root, 'temporarily-retained-original-cache')
  renameSync(cache, retained)
  let rechecked
  try {
    expect(existsSync(launch.run)).toBe(false)
    rechecked = await recheckBuiltinSide(side, hash(binary), receipt)
    writeFileSync(join(evidence, 'recheck.json'), JSON.stringify(rechecked, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  } finally { renameSync(retained, cache) }
  expect(rechecked.verdict).toBe('passed')
  expect(rechecked.productTimingEquivalent).toBe(false)
  expect(rechecked.fullNativeGatePassed).toBe(false)

}, 60000)
