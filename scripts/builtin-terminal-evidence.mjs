import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  lstatSync,
  writeFileSync,
  mkdtempSync,
  linkSync,
  rmSync,
} from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, URL } from 'node:url'
import { readOwnedNativeFile } from './native-evidence-files.mjs'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const quote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`
const append = (path, value) =>
  appendFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600 })
const frames = (launch, strict = false) => {
  const path = join(launch.run, 'frames.jsonl')
  if (!existsSync(path)) return []
  const text = (strict ? readOwnedNativeFile(path).toString('utf8') : readFileSync(path, 'utf8')),
    lines = text.split('\n')
  if (!strict && !text.endsWith('\n')) lines.pop()
  return lines.filter(Boolean).map((line) => JSON.parse(line))
}
const boundary = (launch) => ({
  lastObservedFrameId: frames(launch).at(-1)?.frameId ?? null,
  lastObservedIoId: existsSync(join(launch.run, 'pty-io.jsonl'))
    ? readFileSync(join(launch.run, 'pty-io.jsonl'), 'utf8').split('\n')
      .filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)] } catch { return [] }
      }).at(-1)?.ioId ?? null
    : null,
  observedRawBytes: existsSync(join(launch.run, 'pty.raw'))
    ? statSync(join(launch.run, 'pty.raw')).size
    : 0,
})
export function createBuiltinCapture(run, argv, env, identity = {}) {
  const nativeJournal = identity.nativeJournal === true
  if (nativeJournal && process.platform !== 'darwin')
    throw Error('Native shared-slot capture requires Darwin')
  const initialSize = identity.initialSize ?? { columns: 160, rows: 50 }
  if (!['columns', 'rows'].every((key) =>
    Number.isSafeInteger(initialSize[key]) && initialSize[key] > 0 &&
    initialSize[key] <= 1000))
    throw Error('Invalid initial terminal geometry')
  const placement = identity.brokerPlacement ?? 'direct-native-exec'
  if (!['direct-native-exec', 'launcher-final-native-exec'].includes(placement))
    throw Error('Unknown native PTY broker placement')
  if (nativeJournal) {
    for (const name of ['observer.dylib', 'observer-compile.log', 'native-observer.json',
      'pty.raw', 'inputs.jsonl', 'observations.jsonl', 'geometry.jsonl',
      'launch-captured.sh', 'capture-output.sh']) {
      try { lstatSync(join(run, name)) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      throw Error('Preexisting terminal capture artifact is not owned by this prepare')
    }
  }
  const ready = join(run, 'capture-ready'),
    eof = join(run, 'capture-eof'),
    raw = join(run, 'pty.raw'),
    wrapper = join(run, 'launch-captured.sh'),
    collector = join(run, 'capture-output.sh')
  env.CLAUDE_CODE_FRAME_EVIDENCE_PATH = join(run, 'frames.jsonl')
  env.CLAUDE_CODE_FRAME_BROKER_DIR = run
  env.CLAUDE_CODE_FRAME_NATIVE_JOURNAL = nativeJournal ? '1' : ''
  const captureId = randomUUID()
  env.CLAUDE_CODE_FRAME_CAPTURE_ID = captureId
  if (identity.binarySha256)
    env.CLAUDE_CODE_FRAME_BINARY_SHA256 = identity.binarySha256
  if (placement === 'launcher-final-native-exec') {
    if (!/^[a-f0-9]{64}$/.test(identity.binarySha256 ?? ''))
      throw Error('Launcher capture requires the native binary hash')
    env.CC_VALIDATION_FRAME_EVIDENCE_PATH = env.CLAUDE_CODE_FRAME_EVIDENCE_PATH
    env.CC_VALIDATION_FRAME_BROKER_DIR = run
    env.CC_VALIDATION_FRAME_CAPTURE_ID = captureId
    env.CC_VALIDATION_FRAME_BINARY_SHA256 = identity.binarySha256
    env.CC_VALIDATION_FRAME_NATIVE_JOURNAL = env.CLAUDE_CODE_FRAME_NATIVE_JOURNAL
  }
  if (nativeJournal) {
    const library = join(run, 'observer.dylib')
    const compileRoot = mkdtempSync(join(run, '.native-observer-'))
    const compiled = join(compileRoot, 'observer.dylib')
    const source = fileURLToPath(new URL('./native-terminal-journal.c', import.meta.url))
    try {
      const output = execFileSync('/usr/bin/clang', [
        '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-dynamiclib', source, '-o', compiled,
      ], { encoding: 'utf8', timeout: 30000 })
      linkSync(compiled, library)
      writeFileSync(join(run, 'observer-compile.log'), output, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      writeFileSync(join(run, 'observer-compile.log'), String(error), { flag: 'wx', mode: 0o600 })
      throw error
    } finally {
      rmSync(compileRoot, { recursive: true, force: true })
    }
    writeFileSync(join(run, 'native-observer.json'), JSON.stringify({
      method: 'native-shared-slot-v1', library, librarySha256: hash(readFileSync(library)),
    }) + '\n', { flag: 'wx', mode: 0o600 })
  }
  for (const name of [
    'pty.raw',
    'inputs.jsonl',
    'observations.jsonl',
    'geometry.jsonl',
  ])
    writeFileSync(join(run, name), '', { flag: 'wx', mode: 0o600 })
  append(join(run, 'geometry.jsonl'), {
    geometryId: 0,
    columns: initialSize.columns,
    rows: initialSize.rows,
    phase: 'launch',
    rawOffset: 0,
    lastObservedFrameId: null,
  })
  const broker = fileURLToPath(
    new URL('./terminal-evidence-broker.py', import.meta.url),
  )
  writeFileSync(
    wrapper,
    `#!/bin/sh\numask 077\nwhile [ ! -f ${quote(ready)} ]; do /bin/sleep 0.02; done\n/bin/stty -g > ${quote(join(run, 'initial-termios.txt'))}\nexec ${placement === 'direct-native-exec' ? `/usr/bin/python3 ${quote(broker)} --run ${quote(run)} -- ` : ''}${argv.map(quote).join(' ')}\n`,
    { flag: 'wx', mode: 0o700 },
  )
  writeFileSync(
    collector,
    `#!/bin/sh\numask 077\n/bin/cat > ${quote(raw)}\nstatus=$?\n/bin/echo "$status" > ${quote(eof)}\nexit "$status"\n`,
    { flag: 'wx', mode: 0o700 },
  )
  return {
    wrapper,
    collector,
    ready,
    eof,
    raw,
    broker,
    captureId,
    frames: env.CLAUDE_CODE_FRAME_EVIDENCE_PATH,
    initialSize,
    brokerPlacement: placement,
    nativeTerminalFlagsChanged: false,
    nativeJournal,
    transport:
      'owned PTY broker; outer transport raw mode, native initial flags preserved',
  }
}
export function installBuiltinCapture(launch, capture, execute = execFileSync) {
  const base = ['-S', launch.socket]
  try {
    execute(
      launch.tmux,
      [...base, 'pipe-pane', '-o', '-t', launch.target, capture.collector],
      { env: launch.env, encoding: 'utf8', timeout: 10000 },
    )
    const active = execute(
      launch.tmux,
      [...base, 'display-message', '-p', '-t', launch.target, '#{pane_pipe}'],
      { env: launch.env, encoding: 'utf8', timeout: 10000 },
    ).trim()
    if (active !== '1')
      throw Error('PTY recorder was not installed before native startup')
    writeFileSync(capture.ready, 'installed\n', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    try {
      execute(launch.tmux, [...base, 'kill-server'], {
        env: launch.env,
        encoding: 'utf8',
        timeout: 10000,
      })
    } catch (cleanupError) {
      writeFileSync(
        join(launch.run, 'capture-startup-cleanup-error.json'),
        JSON.stringify({
          error: String(cleanupError),
          socket: launch.socket,
          target: launch.target,
        }) + '\n',
        { mode: 0o600 },
      )
    }
    throw error
  }
}
export function inputBytes(args) {
  const rest = args.slice(args.indexOf('-t') + 2)
  if (rest[0] === '-l') return Buffer.from(rest.slice(1).join(''), 'utf8')
  const keys = {
    Enter: '0d',
    Tab: '09',
    Escape: '1b',
    'C-x': '18',
    Down: '1b5b42',
    Up: '1b5b41',
    Left: '1b5b44',
    Right: '1b5b43',
    'C-c': '03',
    'C-u': '15',
    BTab: '1b5b5a',
  }
  if (rest.some((key) => !Object.hasOwn(keys, key)))
    throw Error('Unrecorded terminal input key')
  return Buffer.from(rest.map((key) => keys[key]).join(''), 'hex')
}
export function recordedBuiltinTmux(launch, args, execute = execFileSync) {
  const input = args[0] === 'send-keys',
    resize = args[0] === 'resize-window',
    before = boundary(launch)
  const inputsPath = join(launch.run, 'inputs.jsonl'),
    sequence = input
      ? readFileSync(inputsPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((row) => row.phase === 'send').length + 1
      : undefined
  let resizeAction
  let resizeGeometry
  let actual = args
  if (input) {
    const bytes = inputBytes(args)
    actual = [
      'send-keys',
      '-t',
      launch.target,
      '-H',
      ...Array.from(bytes, (value) => value.toString(16).padStart(2, '0')),
    ]
    append(inputsPath, {
      actionId: sequence,
      phase: 'send',
      hex: bytes.toString('hex'),
      args,
      actualArgs: actual,
      ...before,
      chunkClaim: 'one send command; native read grouping unknown',
    })
  }
  if (resize) {
    const columns = Number(args[args.indexOf('-x') + 1]),
      rows = Number(args[args.indexOf('-y') + 1])
    if (
      !Number.isInteger(columns) ||
      columns <= 0 ||
      !Number.isInteger(rows) ||
      rows <= 0
    )
      throw Error('Invalid terminal resize evidence')
    resizeAction = readFileSync(join(launch.run, 'geometry.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(JSON.parse)
      .filter((row) => row.phase === 'resize-send').length + 1
    resizeGeometry = { actionId: resizeAction, columns, rows,
      target: launch.target, actualArgs: args }
    append(join(launch.run, 'geometry.jsonl'), {
      ...resizeGeometry,
      phase: 'resize-send',
      columns,
      rows,
      ...before,
    })
  }
  try {
    const output = execute(launch.tmux, ['-S', launch.socket, ...actual], {
      encoding: 'utf8',
      timeout: 10000,
    })
    if (input)
      append(inputsPath, {
        actionId: sequence,
        phase: 'sent',
        exitCodes: [0],
        ...boundary(launch),
      })
    if (args[0] === 'capture-pane')
      append(join(launch.run, 'observations.jsonl'), {
        observationId:
          readFileSync(join(launch.run, 'observations.jsonl'), 'utf8')
            .split('\n')
            .filter(Boolean).length + 1,
        ...boundary(launch),
        textSHA256: hash(Buffer.from(output)),
        args,
      })
    if (resize)
      append(join(launch.run, 'geometry.jsonl'), {
        ...resizeGeometry,
        phase: 'resize-return',
        exitCode: 0,
        ...boundary(launch),
      })
    return output
  } catch (error) {
    if (resize)
      append(join(launch.run, 'geometry.jsonl'), {
        ...resizeGeometry, phase: 'resize-return',
        exitCode: error.status ?? -1, ...boundary(launch),
      })
    if (input)
      append(inputsPath, {
        actionId: sequence,
        phase: 'failed',
        error: error.message,
        ...boundary(launch),
      })
    throw error
  }
}
export async function sealBuiltinCapture(launch, timeout = 5000) {
  const eof = join(launch.run, 'capture-eof'),
    deadline = Date.now() + timeout
  while (!existsSync(eof) && Date.now() < deadline) await delay(25)
  if (launch.capture.nativeJournal) return sealNativeBuiltinCapture(launch)
  const names = [
      'pty.raw',
      'frames.jsonl',
      'inputs.jsonl',
      'observations.jsonl',
      'geometry.jsonl',
      'initial-termios.txt',
      'capture-eof',
    ],
    files = {}
  for (const name of names) {
    const path = join(launch.run, name)
    if (existsSync(path)) {
      const bytes = readOwnedNativeFile(path)
      files[name] = { path, bytes: bytes.length, sha256: hash(bytes) }
    }
  }
  const capturedFrames = frames(launch, true),
    raw = existsSync(join(launch.run, 'pty.raw'))
      ? readOwnedNativeFile(join(launch.run, 'pty.raw'))
      : Buffer.alloc(0)
  let offset = 0,
    firstDifference
  const intervals = []
  for (const [index, entry] of capturedFrames.entries()) {
    const output = Buffer.from(entry.outputBase64, 'base64')
    if (!firstDifference && entry.frameId !== index + 1)
      firstDifference = {
        frameId: entry.frameId,
        offset,
        reason: 'frame ID is duplicated, missing, or out of order',
      }
    if (
      !firstDifference &&
      !raw.subarray(offset, offset + output.length).equals(output)
    )
      firstDifference = {
        frameId: entry.frameId,
        offset,
        reason:
          'producer output group differs from independent PTY stream; prefix/interleaving/translation must be accounted explicitly',
      }
    intervals.push({
      frameId: entry.frameId,
      outputGroupId: entry.frameId,
      start: offset,
      end: offset + output.length,
    })
    offset += output.length
  }
  let stream = {
    intervals,
    producerBytes: offset,
    rawBytes: raw.length,
    tailBytes: Math.max(0, raw.length - offset),
    firstDifference,
    verdict:
      capturedFrames.length && !firstDifference && offset <= raw.length
        ? 'passed'
        : 'failed',
    method:
      'strict contiguous byte equality from offset zero; no search, trimming or skipped frames',
  }
  const eofPassed = existsSync(eof) && readOwnedNativeFile(eof).toString('utf8').trim() === '0'
  let physical
  if (eofPassed && capturedFrames.some((frame) => frame.broker)) {
    const verifier = fileURLToPath(
        new URL('./verify-pty-terminal-evidence.mjs', import.meta.url),
      ),
      output = join(launch.run, 'frame-physical-report.json')
    try {
      execFileSync(process.execPath, [verifier, launch.run, output], {
        env: launch.env,
        encoding: 'utf8',
        timeout: 60000,
      })
    } catch (error) {
      writeFileSync(
        join(launch.run, 'frame-verifier-error.txt'),
        String(error) + '\n',
        { mode: 0o600 },
      )
    }
    if (existsSync(output)) physical = JSON.parse(readOwnedNativeFile(output).toString('utf8'))
    stream = {
      method:
        'owned native PTY complete byte ledger and acknowledged frame boundaries',
      verdict:
        physical?.rawBytes === raw.length && physical?.unmappedBytes === 0
          ? 'passed'
          : 'failed',
      rawBytes: raw.length,
      frameCount: capturedFrames.length,
      unmappedBytes: physical?.unmappedBytes ?? raw.length,
      intervals: physical?.intervals ?? [],
      firstDifference: physical?.error,
    }
  }
  writeFileSync(
    join(launch.run, 'frame-stream-map.json'),
    JSON.stringify(stream, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  )
  for (const name of [
    'native-pty.raw',
    'native-pty-initial.json',
    'native-pty-eof.json',
    'native-input.jsonl',
    'broker-cleanup.json',
    'pty-io.jsonl',
    'frame-stream-map.json',
    'frame-physical-report.json',
  ]) {
    const path = join(launch.run, name)
    if (existsSync(path)) {
      const bytes = readOwnedNativeFile(path)
      files[name] = { path, bytes: bytes.length, sha256: hash(bytes) }
    }
  }
  const report = {
    binarySha256: launch.binarySha256,
    captureId: launch.capture.captureId,
    target: launch.target,
    pane: launch.pane,
    initialSize: physical?.initialSize ?? null,
    requestedInitialSize: launch.capture.initialSize,
    files,
    frameCount: capturedFrames.length,
    eofPassed,
    stream,
    normalProjection: physical?.method ?? 'not covered',
    cursorVisibility: physical
      ? 'explicit producer mode versus independent terminal'
      : 'not covered when omitted by producer',
    nativeReadWriteIds: physical
      ? 'owned PTY read chunks and acknowledged render transactions'
      : 'not recorded',
    framePhysicalVerdict: physical?.verdict ?? 'not covered',
    framePhysicalScope: physical?.scope ?? 'not covered',
    productTimingEquivalent: false,
    verdict:
      eofPassed &&
      capturedFrames.length &&
      raw.length &&
      files['inputs.jsonl']?.bytes
        ? 'captured'
        : 'failed',
  }
  writeFileSync(
    join(launch.run, 'terminal-capture.json'),
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  )
  return report
}

function sealNativeBuiltinCapture(launch) {
  const run = launch.run, files = {}
  const expectedPath = join(run, 'expected-native.json')
  let expected, physical, failure, normal = false
  try {
    const producerPath = join(run, 'producer-expected-native.json'), producer = lstatSync(producerPath)
    if (!producer.isFile() || producer.isSymbolicLink() || producer.nlink !== 1 ||
        (producer.mode & 0o777) !== 0o600 || producer.uid !== process.getuid())
      throw Error('Producer expectation file identity changed')
    expected = JSON.parse(readOwnedNativeFile(producerPath, 0o600))
    const start = JSON.parse(readOwnedNativeFile(join(run, 'start.json'), 0o600))
    if (expected.binarySha256 !== launch.binarySha256 ||
        expected.captureId !== launch.capture.captureId || expected.childPid !== start.childPid ||
        expected.columns !== launch.capture.initialSize.columns ||
        expected.rows !== launch.capture.initialSize.rows || expected.backend !== 'native-shared-slot-v1')
      throw Error('Producer expectation differs from prepared native identity')
    for (const name of ['launch.json', 'cleanup.json', 'broker-cleanup.json', 'native-initial.json',
      'registration.json', 'header.json', 'journal.bin', 'records.bin', 'raw.bin', 'native-pty.raw',
      'pty.raw', 'pty-io.jsonl', 'frames.jsonl', 'capture-eof']) readOwnedNativeFile(join(run, name), 0o600)
    writeFileSync(expectedPath, JSON.stringify(expected) + '\n', { flag: 'wx', mode: 0o600 })
    execFileSync(process.execPath, [fileURLToPath(new URL('./native-frame-journal-replay.mjs', import.meta.url)),
      run, join(run, 'frame-physical-report.json'), expectedPath], {
      env: launch.env, encoding: 'utf8', timeout: 60000,
    })
    normal = JSON.parse(readOwnedNativeFile(join(run, 'cleanup.json'), 0o600)).normalCompletion === true
  } catch (error) { failure = String(error) }
  if (existsSync(join(run, 'frame-physical-report.json'))) {
    try { physical = JSON.parse(readOwnedNativeFile(join(run, 'frame-physical-report.json'), 0o600)) }
    catch (error) { failure ??= String(error) }
  }
  for (const name of [
    'pty.raw', 'native-pty.raw', 'raw.bin', 'records.bin', 'journal.bin', 'registration.json',
    'header.json', 'native-initial.json', 'start.json', 'launch.json', 'cleanup.json',
    'broker-cleanup.json', 'pty-io.jsonl', 'frames.jsonl', 'inputs.jsonl', 'geometry.jsonl',
    'observations.jsonl', 'initial-termios.txt', 'capture-eof', 'expected-native.json',
    'producer-expected-native.json',
    'native-observer.json', 'observer.dylib', 'observer-compile.log', 'frame-physical-report.json',
  ]) {
    const path = join(run, name)
    if (existsSync(path)) {
      try {
        const bytes = readOwnedNativeFile(path)
        files[name] = { path, bytes: bytes.length, sha256: hash(bytes) }
      } catch (error) { failure ??= String(error) }
    }
  }
  let eofPassed = false
  if (files['capture-eof']) {
    try { eofPassed = readOwnedNativeFile(files['capture-eof'].path, 0o600).toString('utf8').trim() === '0' }
    catch (error) { failure ??= String(error) }
  }
  const rawMatched = files['pty.raw'] && files['raw.bin'] && files['native-pty.raw'] &&
    files['pty.raw'].sha256 === files['raw.bin'].sha256 && files['raw.bin'].sha256 === files['native-pty.raw'].sha256
  const nativeContentMatched = expected?.nativeClose?.method === 'owned-broker-closed-native-v1' &&
    ['raw.bin', 'native-pty.raw', 'pty.raw', 'records.bin', 'registration.json', 'header.json', 'native-initial.json']
      .every(name => files[name]?.bytes === expected.nativeClose.files?.[name]?.bytes &&
        files[name]?.sha256 === expected.nativeClose.files?.[name]?.sha256)
  const nativeIOMatched = typeof expected?.ioClose?.sha256 === 'string' &&
    files['pty-io.jsonl']?.sha256 === expected.ioClose.sha256
  const boundedPassed = !failure && normal && eofPassed && rawMatched && nativeContentMatched && nativeIOMatched && physical?.verdict === 'passed'
  const report = {
    backend: 'native-shared-slot-v1', binarySha256: launch.binarySha256,
    captureId: launch.capture.captureId, target: launch.target, pane: launch.pane,
    files, frameCount: physical?.frameCount ?? 0, eofPassed: Boolean(eofPassed),
    requestedInitialSize: launch.capture.initialSize,
    stream: { method: 'native-shared-slot-v1', verdict: rawMatched ? 'passed' : 'failed' },
    framePhysicalVerdict: physical?.verdict ?? 'failed',
    framePhysicalBoundary: physical?.framePhysicalBoundary ?? null,
    nativeResizeBracketsCovered: physical?.verdict === 'passed' && physical.nativeResizeBracketsCovered === true,
    nativeContentMatched: Boolean(nativeContentMatched), nativeIOMatched: Boolean(nativeIOMatched),
    boundedVerdict: boundedPassed ? 'passed' : 'failed', failure,
    productTimingEquivalent: false, fullNativeGatePassed: false,
    verdict: 'failed',
    remaining: ['termios lifetime', 'child-side unobserved geometry changes', 'actual OS input/parser/owner',
                'open-close-reopen matrix', 'product scheduling comparison', 'default release matrix'],
  }
  const streamPath = join(run, 'frame-stream-map.json'), streamBytes = Buffer.from(JSON.stringify(report.stream, null, 2) + '\n')
  writeFileSync(streamPath, streamBytes, { flag: 'wx', mode: 0o600 })
  files['frame-stream-map.json'] = { path: streamPath, bytes: streamBytes.length, sha256: hash(streamBytes) }
  writeFileSync(join(run, 'terminal-capture.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return report
}

/** Closed native identity/content only; OS input ownership and timing are separate. */
export function validateNativeTerminalEvidence(side, diagnostics) {
  let phase = 'capture', error
  try {
    const capture = side?.cleanup?.terminalCapture
    if (capture?.backend !== 'native-shared-slot-v1' || capture.boundedVerdict !== 'passed' ||
        capture.framePhysicalVerdict !== 'passed' || capture.eofPassed !== true ||
        capture.stream?.method !== 'native-shared-slot-v1' || capture.stream.verdict !== 'passed' ||
        capture.nativeContentMatched !== true || capture.nativeIOMatched !== true ||
        capture.binarySha256 !== side.binarySha256 || capture.captureId !== side.captureId ||
        capture.target !== side.target || capture.pane !== side.pane || !side.captureId ||
        !/^[a-f0-9]{64}$/.test(side.binarySha256) || !isAbsolute(side.run) ||
        !Number.isSafeInteger(capture.frameCount) || capture.frameCount <= 0)
      return false
    const root = realpathSync(side.run), data = new Map()
    const names = ['pty.raw', 'raw.bin', 'native-pty.raw', 'records.bin', 'registration.json',
      'header.json', 'native-initial.json', 'start.json', 'launch.json', 'cleanup.json',
      'broker-cleanup.json', 'pty-io.jsonl', 'frames.jsonl', 'inputs.jsonl', 'geometry.jsonl',
      'observations.jsonl', 'initial-termios.txt', 'capture-eof', 'expected-native.json',
      'producer-expected-native.json', 'frame-stream-map.json', 'frame-physical-report.json']
    for (const name of names) {
      phase = 'file:' + name
      const path = join(root, name), info = capture.files?.[name]
      if (info?.path !== path || !Number.isSafeInteger(info.bytes) || info.bytes < 0 ||
          !/^[a-f0-9]{64}$/.test(info.sha256)) return false
      const bytes = readOwnedNativeFile(path, 0o600)
      if (bytes.length !== info.bytes || hash(bytes) !== info.sha256) return false
      data.set(name, bytes)
    }
    phase = 'native-close-identity'
    const json = name => JSON.parse(data.get(name).toString('utf8')),
      jsonl = name => data.get(name).toString('utf8').split('\n').filter(Boolean).map(JSON.parse),
      start = json('start.json'), launch = json('launch.json'), cleanup = json('cleanup.json'),
      expected = json('expected-native.json'), producer = json('producer-expected-native.json'),
      physical = json('frame-physical-report.json'), header = json('header.json')
    if (!Number.isSafeInteger(start.childPid) || start.childPid <= 0 || start.childPgid !== start.childPid ||
        start.binarySha256 !== side.binarySha256 || launch.binarySha256 !== side.binarySha256 ||
        launch.captureId !== side.captureId || launch.command?.[0] !== join(root, 'bin/claude') ||
        cleanup.backend !== 'native-shared-slot-v1' || cleanup.captureId !== side.captureId ||
        cleanup.childPid !== start.childPid || cleanup.childExitCode !== 0 ||
        cleanup.childReaped !== true || cleanup.physicalEof !== true || cleanup.normalCompletion !== true ||
        cleanup.failure !== null || !isDeepStrictEqual(cleanup.cleanupErrors, []) ||
        !isDeepStrictEqual(cleanup.signalsSent, []) || !isDeepStrictEqual(json('broker-cleanup.json'), cleanup) ||
        data.get('capture-eof').toString('utf8').trim() !== '0' ||
        expected.backend !== 'native-shared-slot-v1' || expected.childPid !== start.childPid ||
        expected.binarySha256 !== side.binarySha256 || expected.captureId !== side.captureId ||
        expected.columns !== capture.requestedInitialSize?.columns || expected.rows !== capture.requestedInitialSize?.rows ||
        !isDeepStrictEqual(expected, producer) ||
        !isDeepStrictEqual(expected.nativeClose, cleanup.nativeClose) ||
        !isDeepStrictEqual(expected.ioClose, cleanup.ioClose)) return false
    phase = 'original-close-content'
    const content = expected.nativeClose, io = expected.ioClose,
      nativeNames = ['raw.bin', 'native-pty.raw', 'pty.raw', 'records.bin', 'native-initial.json', 'registration.json', 'header.json']
    if (content?.method !== 'owned-broker-closed-native-v1' ||
        !Number.isSafeInteger(content.recordCount) || content.recordCount <= 0 ||
        !isDeepStrictEqual(Object.keys(content.files ?? {}).sort(), nativeNames.sort()) ||
        !nativeNames.every(name => content.files[name]?.bytes === data.get(name).length &&
          content.files[name]?.sha256 === hash(data.get(name))) ||
        io?.method !== 'owned-broker-closed-io-v1' || io.sha256 !== hash(data.get('pty-io.jsonl')) ||
        io.recordCount !== jsonl('pty-io.jsonl').length || io.rawBytes !== data.get('pty.raw').length ||
        !data.get('pty.raw').equals(data.get('raw.bin')) || !data.get('pty.raw').equals(data.get('native-pty.raw')) ||
        !Array.isArray(header) || header.length !== 32 || header[8] !== start.childPid ||
        header[9] !== content.recordCount || header[10] !== 0 || header[11] !== 1 ||
        !isDeepStrictEqual(json('frame-stream-map.json'), capture.stream))
      return false
    phase = 'native-physical-report'
    const entries = jsonl('frames.jsonl')
    if (!data.get('frames.jsonl').toString('utf8').endsWith('\n') || entries.length !== capture.frameCount ||
        !entries.every((frame, index) => frame.frameId === index + 1 &&
          frame.native?.captureId === side.captureId && frame.native.spanId === frame.frameId &&
          frame.native.profile === 'ink-post-write-v1') ||
        physical.method !== 'native-journal-ioctl-geometry-replay-v1' || physical.verdict !== 'passed' ||
        physical.rawBytes !== data.get('pty.raw').length || physical.rawSha256 !== hash(data.get('pty.raw')) ||
        physical.frameCount !== entries.length || !Array.isArray(physical.frames) ||
        physical.frames.length !== entries.length || !physical.frames.every((frame, index) =>
          frame.frameId === index + 1 && frame.verdict === 'passed') ||
        physical.closure?.verdict !== 'passed' || physical.closure.buffer !== 'normal' ||
        physical.closure.cursorVisible !== true) return false
    // The bounded v1 protocol cannot acquire timing/input coverage via edited labels.
    phase = 'bounded-coverage-claims'
    if ([capture, physical, cleanup].some(value =>
      value.productTimingEquivalent !== false || value.fullNativeGatePassed !== false)) return false
    phase = 'native-binary'
    const passed = hash(readOwnedNativeFile(join(root, 'bin/claude'))) === side.binarySha256
    if (passed) phase = 'passed'
    return passed
  } catch (failure) { error = failure.message; return false }
  finally { if (diagnostics) Object.assign(diagnostics, { phase, ...(error ? { error } : {}) }) }
}

export function validateBuiltinTerminalEvidence(side) {
  try {
    const capture = side?.cleanup?.terminalCapture
    if (
      !capture ||
      capture.framePhysicalVerdict !== 'passed' ||
      capture.eofPassed !== true ||
      capture.stream?.verdict !== 'passed' ||
      capture.binarySha256 !== side.binarySha256 ||
      capture.target !== side.target ||
      capture.pane !== side.pane ||
      !side.captureId ||
      capture.captureId !== side.captureId
    )
      return false
    if (
      !isAbsolute(side.run) ||
      !Number.isInteger(capture.frameCount) ||
      capture.frameCount < 1
    )
      return false
    const files = capture.files,
      root = realpathSync(side.run)
    for (const name of [
      'pty.raw',
      'native-pty.raw',
      'native-pty-initial.json',
      'native-pty-eof.json',
      'native-input.jsonl',
      'pty-io.jsonl',
      'broker-cleanup.json',
      'frames.jsonl',
      'inputs.jsonl',
      'geometry.jsonl',
      'initial-termios.txt',
      'capture-eof',
      'frame-stream-map.json',
      'frame-physical-report.json',
    ]) {
      const file = files?.[name]
      if (!file || realpathSync(file.path) !== join(root, name)) return false
      const owned = relative(root, realpathSync(file.path))
      if (owned.startsWith('..') || isAbsolute(owned)) return false
      const bytes = readOwnedNativeFile(file.path)
      if (
        !bytes.length ||
        file.bytes !== bytes.length ||
        file.sha256 !== hash(bytes)
      )
        return false
    }
    if (
      readOwnedNativeFile(files['capture-eof'].path).toString('utf8').trim() !== '0' ||
      files['pty.raw'].sha256 !== files['native-pty.raw'].sha256
    )
      return false
    const initial = JSON.parse(
        readOwnedNativeFile(files['native-pty-initial.json'].path).toString('utf8'),
      ),
      eof = JSON.parse(readOwnedNativeFile(files['native-pty-eof.json'].path).toString('utf8')),
      cleanup = JSON.parse(
        readOwnedNativeFile(files['broker-cleanup.json'].path).toString('utf8'),
      )
    if (
      initial.captureId !== side.captureId ||
      initial.binarySha256 !== side.binarySha256 ||
      initial.pid !== initial.pgid ||
      eof.captureId !== side.captureId ||
      eof.childPid !== initial.pid ||
      eof.childExitCode !== 0 ||
      eof.rawBytes !== files['pty.raw'].bytes ||
      cleanup.captureId !== side.captureId ||
      cleanup.childPid !== initial.pid ||
      cleanup.childReaped !== true ||
      JSON.stringify(cleanup.fifoRemoved) !==
        JSON.stringify(['frame-request.fifo', 'frame-response.fifo'])
    )
      return false
    if (hash(readOwnedNativeFile(join(root, 'bin/claude'))) !== side.binarySha256)
      return false
    const producerFrames = frames({ run: root }, true)
    if (
      producerFrames.length !== capture.frameCount ||
      !producerFrames.every(
        (frame) =>
          frame.captureId === side.captureId && frame.pid === initial.pid,
      )
    )
      return false
    const jsonl = (path) =>
      readOwnedNativeFile(path).toString('utf8').trim().split('\n').map(JSON.parse)
    const reads = jsonl(files['native-input.jsonl'].path)
    if (
      !reads.every(
        (read, index) =>
          read.readId === index + 1 &&
          read.captureId === side.captureId &&
          read.pid === initial.pid &&
          read.representation === 'decoded-utf8' &&
          typeof read.hex === 'string' &&
          /^(?:[a-f0-9]{2})+$/.test(read.hex),
      )
    )
      return false
    const inputs = jsonl(files['inputs.jsonl'].path),
      sends = inputs.filter((input) => input.phase === 'send'),
      sent = inputs.filter((input) => input.phase === 'sent')
    const physical = JSON.parse(
      readOwnedNativeFile(files['frame-physical-report.json'].path).toString('utf8'),
    )
    if (!validateCaptureInputs(root, side.target, inputs,
        jsonl(files['pty-io.jsonl'].path), physical.inputProof) ||
        physical.inputsSHA256 !== files['inputs.jsonl'].sha256)
      return false
    if (
      physical.method !== 'independent-pty-replay-v1' ||
      physical.verdict !== 'passed' ||
      physical.rawSHA256 !== files['pty.raw'].sha256 ||
      physical.framesSHA256 !== files['frames.jsonl'].sha256 ||
      physical.geometrySHA256 !== files['geometry.jsonl'].sha256 ||
      physical.ioSHA256 !== files['pty-io.jsonl'].sha256 ||
      physical.frameCount !== capture.frameCount
    )
      return false
    if (
      !Array.isArray(physical.frames) ||
      physical.frames.length !== capture.frameCount ||
      !physical.frames.every(
        (frame, index) =>
          frame.frameId === index + 1 && frame.verdict === 'passed',
      )
    )
      return false
    const stream = JSON.parse(
      readOwnedNativeFile(files['frame-stream-map.json'].path).toString('utf8'),
    )
    return (
      stream.verdict === 'passed' &&
      stream.rawBytes === files['pty.raw'].bytes &&
      stream.unmappedBytes === 0 &&
      stream.frameCount === capture.frameCount
    )
  } catch {
    return false
  }
}

export function captureInputIntent(root, target, inputs) {
  try {
    const sends = inputs.filter(row => row.phase === 'send'),
      sent = inputs.filter(row => row.phase === 'sent')
    if (!sends.length || inputs.length !== sends.length * 2 ||
        sent.length !== sends.length) return null
    for (const [index, send] of sends.entries()) {
      const returned = sent[index]
      if (send.actionId !== index + 1 || returned.actionId !== send.actionId ||
          !/^(?:[a-f0-9]{2})+$/.test(send.hex)) return null
      if (send.transport === 'tmux-paste-buffer') {
        const path = send.inputFile
        if (!isAbsolute(path) || lstatSync(path).isSymbolicLink() ||
            realpathSync(path) !== path ||
            relative(root, path).startsWith('..') ||
            isAbsolute(relative(root, path))) return null
        const bytes = readOwnedNativeFile(path)
        if (send.target !== target || bytes.toString('hex') !== send.hex ||
            hash(bytes) !== send.bytesSHA256 ||
            JSON.stringify(send.actualCommands) !== JSON.stringify([
              ['load-buffer', '-b', send.buffer, path],
              ['paste-buffer', '-b', send.buffer, '-t', target],
            ]) || JSON.stringify(returned.exitCodes) !== '[0,0]') return null
      } else {
        if (send.transport && send.transport !== 'tmux-send-keys') return null
        if (send.args?.[0] !== 'send-keys' || send.args[2] !== target ||
            inputBytes(send.args).toString('hex') !== send.hex ||
            JSON.stringify(returned.exitCodes) !== '[0]') return null
        if (send.actualArgs && JSON.stringify(send.actualArgs) !==
            JSON.stringify(['send-keys', '-t', target, '-H',
              ...Array.from(Buffer.from(send.hex, 'hex'),
                byte => byte.toString(16).padStart(2, '0'))])) return null
      }
    }
    return Buffer.from(sends.map(row => row.hex).join(''), 'hex')
  } catch {
    return null
  }
}

export function validateCaptureInputs(root, target, inputs, io, proof) {
  const intended = captureInputIntent(root, target, inputs)
  if (!intended) return false
  const actual = io.filter(row => row.kind === 'input')
  if (!actual.length || !actual.every(row => /^(?:[a-f0-9]{2})+$/.test(row.hex)))
    return false
  const bytes = Buffer.from(actual.map(row => row.hex).join(''), 'hex')
  if (bytes.equals(intended)) return true
  return proof?.method === 'parsed-native-terminal-input-v1' &&
    proof.verdict === 'passed' && proof.driverBytes === intended.length &&
    proof.nativeBytes === bytes.length && proof.intendedSHA256 === hash(intended) &&
    proof.nativeInputSHA256 === hash(bytes) && proof.terminalReplies?.length > 0
}
