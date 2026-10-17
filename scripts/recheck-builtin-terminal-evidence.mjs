import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath, URL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { validateBuiltinTerminalEvidence, validateNativeTerminalEvidence } from './builtin-terminal-evidence.mjs'
import { verifyPtyTerminalEvidence } from './verify-pty-terminal-evidence.mjs'
import { replayNativeFrameJournal } from './native-frame-journal-replay.mjs'
import { join, dirname, relative, resolve, isAbsolute } from 'node:path'
import { readOwnedNativeFile } from './native-evidence-files.mjs'
import { nativeEvidenceLocation } from './native-evidence-location.mjs'

export async function recheckBuiltinSide(side, binarySha256, archiveReceiptPath) {
  let launch, evidenceLocation
  try {
    const launchBytes = readOwnedNativeFile(join(side.run, 'capture-launch.json'))
    launch = JSON.parse(launchBytes)
    let preparedRun = launch.run
    if (preparedRun !== realpathSync(side.run) && archiveReceiptPath) {
      const receipt = JSON.parse(readOwnedNativeFile(archiveReceiptPath)),
        originalRelative = relative(receipt.source, preparedRun),
        original = receipt.sourceManifest?.[join(originalRelative, 'capture-launch.json')]
      if (!isAbsolute(receipt.source) || resolve(receipt.source) !== receipt.source ||
          !isAbsolute(preparedRun) || resolve(preparedRun) !== preparedRun ||
          !/^runs\/r-[0-9a-f]{12}$/.test(originalRelative) ||
          receipt.archive !== realpathSync(join(dirname(archiveReceiptPath), 'acceptance-cache')) ||
          resolve(archiveReceiptPath) !== join(dirname(receipt.archive), 'builtin-cache-archive.json') ||
          receipt.archiveComplete !== true || receipt.sourceFilesStable !== true || receipt.archiveFilesMatch !== true ||
          original?.type !== 'file' || original.sha256 !== createHash('sha256').update(launchBytes).digest('hex'))
        throw Error('Prepared archive mapping or original launch digest is invalid')
      preparedRun = join(receipt.archive, originalRelative)
    }
    if (preparedRun !== realpathSync(side.run) || launch.binarySha256 !== binarySha256 ||
        launch.capture?.captureId !== side.captureId || typeof launch.capture?.nativeJournal !== 'boolean' ||
        launch.target !== side.target || launch.pane !== side.pane ||
        (launch.capture.nativeJournal
          ? side.cleanup?.terminalCapture?.backend !== 'native-shared-slot-v1'
          : side.cleanup?.terminalCapture?.backend !== undefined))
      throw Error('Prepared capture protocol or identity differs from terminal report')
    evidenceLocation = nativeEvidenceLocation(side.run, launch.run !== realpathSync(side.run) ? archiveReceiptPath : undefined)
  } catch (error) {
    return { verdict: 'failed', reason: error.message,
      productTimingEquivalent: false, fullNativeGatePassed: false }
  }
  if (launch.capture.nativeJournal) {
    const diagnostics = {}
    if (side.binarySha256 !== binarySha256 || !validateNativeTerminalEvidence(side, diagnostics, evidenceLocation))
      return { verdict: 'failed', reason: 'closed native identity or original content is invalid', nativeValidation: diagnostics,
        productTimingEquivalent: false, fullNativeGatePassed: false }
    try {
      const run = realpathSync(side.run), replay = await replayNativeFrameJournal(run, join(run, 'expected-native.json'), join(run, 'frames.jsonl'), evidenceLocation)
      if (!validateNativeTerminalEvidence(side, diagnostics, evidenceLocation))
        return { verdict: 'failed', reason: 'closed native originals changed during independent replay',
          nativeValidation: diagnostics, productTimingEquivalent: false, fullNativeGatePassed: false }
      return { verdict: replay.verdict, replay, captureId: side.captureId, run,
        scope: 'bounded closed native identity and physical frame replay; input owner and timing are not covered',
        productTimingEquivalent: false, fullNativeGatePassed: false,
        oracleSha256: createHash('sha256').update(readFileSync(new URL('./native-frame-journal-replay.mjs', import.meta.url))).digest('hex'),
        decoderSha256: createHash('sha256').update(readFileSync(new URL('./verify-native-frame-journal.py', import.meta.url))).digest('hex'),
        journalSha256: createHash('sha256').update(readFileSync(new URL('./native-terminal-journal.py', import.meta.url))).digest('hex') }
    } catch (error) {
      return { verdict: 'failed', reason: error.message, productTimingEquivalent: false, fullNativeGatePassed: false }
    }
  }
  if (
    side?.binarySha256 !== binarySha256 ||
    !validateBuiltinTerminalEvidence(side)
  )
    return {
      verdict: 'failed',
      reason: 'sealed native identity, input, EOF or file hashes are invalid',
    }
  try {
    const replay = await verifyPtyTerminalEvidence(realpathSync(side.run))
    return {
      verdict: replay.verdict,
      replay,
      captureId: side.captureId,
      run: realpathSync(side.run),
    }
  } catch (error) {
    return { verdict: 'failed', reason: error.message }
  }
}

export async function recheckBuiltinEvidence(report, binarySha256, archiveReceiptPath) {
  const names = [
    'privacyOff',
    'privacyOn',
    'enabled',
    'disabled',
    'securityOrdinary',
    'securityTeam',
    'securityEnterprise',
  ]
  const sides = names.map((name) => report?.pair?.[name]),
    result = {}
  if (
    sides.some((side) => !side?.captureId || !side?.run) ||
    new Set(sides.map((side) => side.captureId)).size !== names.length ||
    new Set(sides.map((side) => realpathSync(side.run))).size !== names.length
  )
    return {
      verdict: 'failed',
      reason: 'seven distinct owned runs and capture identities are required',
    }
  for (const [index, name] of names.entries())
    result[name] = await recheckBuiltinSide(sides[index], binarySha256, archiveReceiptPath)
  return {
    verdict: Object.values(result).every((side) => side.verdict === 'passed')
      ? 'passed'
      : 'failed',
    scope:
      'independent archived Ink-root frame replay; product timing and complete terminal gate remain separate',
    oracleSha256: createHash('sha256').update(readFileSync(new URL('./verify-pty-terminal-evidence.mjs', import.meta.url))).digest('hex'),
    verifierSha256: createHash('sha256')
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest('hex'),
    sides: result,
  }
}

export async function recheckFinalBuiltinEvidence(input, binarySha256, savedPath, archiveReceiptPath) {
  const report = JSON.parse(readFileSync(input, 'utf8')),
    saved = JSON.parse(readFileSync(savedPath, 'utf8')),
    { assessBuiltinAcceptance } = await import('./mods-test-lab.mjs'),
    assertions = assessBuiltinAcceptance(report.pair),
    current = JSON.parse(JSON.stringify(await recheckBuiltinEvidence(report, binarySha256, archiveReceiptPath)))
  const timingPreserved = Object.values(report.pair).every(side =>
    side.cleanup.terminalCapture.productTimingEquivalent === true &&
    // The acknowledged v1 recorder changes the product render schedule.
    side.cleanup.terminalCapture.stream.method !==
      'owned native PTY complete byte ledger and acknowledged frame boundaries')
  const passed = current.verdict === 'passed' && timingPreserved &&
    isDeepStrictEqual(saved, current) &&
    isDeepStrictEqual(report.assertions, assertions) &&
    Object.values(assertions).every(assertion => assertion.verdict === 'passed')
  return { verdict: passed ? 'passed' : 'failed', acceptance: input,
    binarySha256, reason: passed ? null : 'current seven-side assertions, identity, timing or replay differ from sealed acceptance' }
}

if (import.meta.main) {
  const [input, binarySha256, output, saved, archiveReceipt] = process.argv.slice(2)
  if (input === '--final') {
    let result
    try {
      result = await recheckFinalBuiltinEvidence(binarySha256, output, saved, archiveReceipt)
    } catch (error) { result = { verdict: 'failed', reason: error.message } }
    process.stdout.write(JSON.stringify(result) + '\n')
    if (result.verdict !== 'passed') process.exitCode = 1
  } else {
  if (!input || !output || !/^[a-f0-9]{64}$/.test(binarySha256 ?? ''))
    throw Error(
      'Usage: recheck-builtin-terminal-evidence.mjs ACCEPTANCE.json BINARY_SHA256 OUTPUT.json [ARCHIVE_RECEIPT.json]',
    )
  let result
  try {
    result = await recheckBuiltinEvidence(
      JSON.parse(readFileSync(input, 'utf8')),
      binarySha256,
      saved,
    )
  } catch (error) {
    result = { verdict: 'failed', reason: error.message }
  }
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', {
    mode: 0o600,
  })
  if (result.verdict !== 'passed') process.exitCode = 1
}
}
