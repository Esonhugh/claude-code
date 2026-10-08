import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  createBuiltinCapture,
  installBuiltinCapture,
  sealBuiltinCapture,
  validateBuiltinTerminalEvidence,
} from './builtin-terminal-evidence.mjs'
import { recheckBuiltinSide } from './recheck-builtin-terminal-evidence.mjs'

const [action, descriptor] = process.argv.slice(2)
const launch = JSON.parse(readFileSync(descriptor, 'utf8'))
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
    captureIdentityPassed: validateBuiltinTerminalEvidence(side),
    recheck: await recheckBuiltinSide(side, launch.binarySha256),
  }
  writeFileSync(join(launch.run, 'independent-pty-checks.json'),
    JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
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
    passed = validateBuiltinTerminalEvidence(side) &&
      saved.captureIdentityPassed === true &&
      isDeepStrictEqual(saved.side, side) &&
      isDeepStrictEqual(saved.recheck, recheck) &&
      isDeepStrictEqual(physical, recheck.replay) &&
      recheck.verdict === 'passed'
  process.stdout.write(JSON.stringify({
    verdict: passed ? 'passed' : 'failed',
    run: launch.run, captureId: side.captureId,
    binarySha256: launch.binarySha256,
    reason: passed ? null : 'current identity, inputs or independent PTY replay differs from sealed evidence',
  }) + '\n')
  if (!passed) process.exitCode = 1
} else {
  throw Error('Unknown terminal capture action')
}
