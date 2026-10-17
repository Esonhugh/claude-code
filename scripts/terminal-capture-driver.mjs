import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  createBuiltinCapture,
  installBuiltinCapture,
  sealBuiltinCapture,
  validateBuiltinTerminalEvidence,
  validateNativeTerminalEvidence,
} from './builtin-terminal-evidence.mjs'
import { recheckBuiltinSide } from './recheck-builtin-terminal-evidence.mjs'

const [action, descriptor, ...options] = process.argv.slice(2)
const boundedOnly = options.length === 1 && options[0] === '--bounded'
if (options.length && (!boundedOnly || action !== 'verify'))
  throw Error('Only verify accepts --bounded')
const launch = JSON.parse(readFileSync(descriptor, 'utf8'))
if (action !== 'prepare' && typeof launch.capture?.nativeJournal !== 'boolean')
  throw Error('Prepared capture protocol is missing')
if (action === 'prepare') {
  launch.capture = createBuiltinCapture(
    launch.run, launch.argv, launch.env, {
      binarySha256: launch.binarySha256,
      initialSize: { columns: 200, rows: 60 },
      brokerPlacement: 'launcher-final-native-exec',
      nativeJournal: true,
    },
  )
  writeFileSync(descriptor, JSON.stringify(launch, null, 2) + '\n',
    { mode: 0o600 })
} else if (action === 'install') {
  installBuiltinCapture(launch, launch.capture)
} else if (action === 'seal') {
  const terminalCapture = await sealBuiltinCapture(launch)
  const side = {
    run: launch.run, target: launch.target, pane: launch.pane,
    binarySha256: launch.binarySha256, captureId: launch.capture.captureId,
    cleanup: { terminalCapture },
  }
  const result = {
    side,
    captureIdentityPassed: launch.capture.nativeJournal
      ? validateNativeTerminalEvidence(side) : validateBuiltinTerminalEvidence(side),
    recheck: await recheckBuiltinSide(side, launch.binarySha256),
    productTimingEquivalent: terminalCapture.productTimingEquivalent,
    fullNativeGatePassed: terminalCapture.fullNativeGatePassed,
  }
  writeFileSync(join(launch.run, 'independent-pty-checks.json'),
    JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  // Seal closes bounded originals and physical replay. Full coverage is checked
  // independently at verify; it cannot turn missing input/timing evidence green.
  if (!result.captureIdentityPassed || result.recheck.verdict !== 'passed')
    process.exitCode = 1
} else if (action === 'verify') {
  // Read-only final acceptance: rerun the pinned parser over the sealed bytes.
  // Neither a saved verdict nor a rewritten digest can replace physical replay.
  const saved = JSON.parse(readFileSync(join(launch.run, 'independent-pty-checks.json'), 'utf8')),
    capture = JSON.parse(readFileSync(join(launch.run, 'terminal-capture.json'), 'utf8')),
    physical = JSON.parse(readFileSync(join(launch.run, 'frame-physical-report.json'), 'utf8')),
    side = {
      run: launch.run, target: launch.target, pane: launch.pane,
      binarySha256: launch.binarySha256, captureId: launch.capture.captureId,
      cleanup: { terminalCapture: capture },
    },
    recheck = JSON.parse(JSON.stringify(await recheckBuiltinSide(side, launch.binarySha256))),
    native = launch.capture.nativeJournal,
    boundedPassed = (native ? validateNativeTerminalEvidence(side) : validateBuiltinTerminalEvidence(side)) &&
      saved.captureIdentityPassed === true &&
      isDeepStrictEqual(saved.side, side) &&
      isDeepStrictEqual(saved.recheck, recheck) &&
      isDeepStrictEqual(physical, recheck.replay) &&
      recheck.verdict === 'passed',
    fullCovered = boundedPassed && saved.productTimingEquivalent === true && saved.fullNativeGatePassed === true &&
      capture.productTimingEquivalent === true && capture.fullNativeGatePassed === true &&
      recheck.productTimingEquivalent === true && recheck.fullNativeGatePassed === true,
    passed = boundedPassed && (boundedOnly || fullCovered)
  process.stdout.write(JSON.stringify({
    verdict: passed ? 'passed' : 'failed',
    scope: boundedOnly ? 'bounded identity and independent physical replay' : 'full terminal acceptance',
    boundedVerdict: boundedPassed ? 'passed' : 'failed',
    fullCoverageVerdict: fullCovered ? 'passed' : 'not covered',
    run: launch.run, captureId: side.captureId,
    binarySha256: launch.binarySha256,
    reason: passed ? null : !boundedPassed
      ? 'current identity, inputs or independent PTY replay differs from sealed evidence'
      : 'full input, lifecycle and product timing coverage is not established',
  }) + '\n')
  if (!passed) process.exitCode = 1
} else {
  throw Error('Unknown terminal capture action')
}
