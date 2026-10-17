import { test, expect, afterAll } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBuiltinCapture,
  installBuiltinCapture,
  inputBytes,
  recordedBuiltinTmux,
  sealBuiltinCapture,
  validateCaptureInputs,
} from './builtin-terminal-evidence.mjs'
const roots = []
const fixture = () => {
  const run = mkdtempSync(join(tmpdir(), 'frame-cap-'))
  roots.push(run)
  const env = {}
  const capture = createBuiltinCapture(run, ['/bin/echo', 'fixture'], env)
  return {
    run,
    env,
    capture,
    tmux: '/fixture/tmux',
    socket: join(run, 'socket'),
    target: 'mods:0.0',
    pane: '%1',
    binarySha256: 'a'.repeat(64),
  }
}
afterAll(() =>
  roots.forEach((root) => rmSync(root, { recursive: true, force: true })),
)
test('launcher capture brokers the actual native exec and preserves requested initial geometry', () => {
  const run = mkdtempSync(join(tmpdir(), 'launcher-cap-'))
  roots.push(run)
  const env = {}, binarySha256 = 'b'.repeat(64)
  const capture = createBuiltinCapture(run, ['/owned/launcher.sh'], env, {
    binarySha256, brokerPlacement: 'launcher-final-native-exec',
    initialSize: { columns: 200, rows: 60 },
  })
  const wrapper = readFileSync(capture.wrapper, 'utf8')
  expect(wrapper).toContain("exec '/owned/launcher.sh'")
  expect(wrapper).not.toContain('python3')
  expect(env.CC_VALIDATION_FRAME_BROKER_DIR).toBe(run)
  expect(env.CC_VALIDATION_FRAME_CAPTURE_ID).toBe(capture.captureId)
  expect(env.CC_VALIDATION_FRAME_BINARY_SHA256).toBe(binarySha256)
  expect(capture.initialSize).toEqual({ columns: 200, rows: 60 })
  expect(() => createBuiltinCapture(run, [], {}, {
    initialSize: { columns: 0, rows: 60 },
  })).toThrow('geometry')
})
test('native capture prepares a pinned observer before launcher startup', () => {
  const run = mkdtempSync(join(tmpdir(), 'native-cap-'))
  roots.push(run)
  const env = {}
  const capture = createBuiltinCapture(run, ['/owned/launcher.sh'], env, {
    binarySha256: 'b'.repeat(64), brokerPlacement: 'launcher-final-native-exec',
    initialSize: { columns: 100, rows: 30 }, nativeJournal: true,
  })
  const observer = JSON.parse(readFileSync(join(run, 'native-observer.json'), 'utf8'))
  expect(capture.nativeJournal).toBe(true)
  expect(env.CC_VALIDATION_FRAME_NATIVE_JOURNAL).toBe('1')
  expect(env.CLAUDE_CODE_FRAME_NATIVE_JOURNAL).toBe('1')
  expect(observer.method).toBe('native-shared-slot-v1')
  expect(observer.library).toBe(join(run, 'observer.dylib'))
  expect(observer.librarySha256).toBe(createHash('sha256').update(readFileSync(observer.library)).digest('hex'))
  expect(existsSync(join(run, 'journal.bin'))).toBe(false)
  expect(readFileSync(capture.wrapper, 'utf8')).not.toContain('FRAME_JOURNAL')
})
test('native prepare refuses preexisting observer bytes before compiling', () => {
  const run = mkdtempSync(join(tmpdir(), 'native-existing-'))
  roots.push(run)
  const sentinel = 'preexisting observer must survive'
  const enrollment = JSON.stringify({ ownedBy: 'older capture' })
  writeFileSync(join(run, 'observer.dylib'), sentinel)
  writeFileSync(join(run, 'native-observer.json'), enrollment)
  expect(() => createBuiltinCapture(run, ['/owned/launcher.sh'], {}, {
    binarySha256: 'b'.repeat(64), brokerPlacement: 'launcher-final-native-exec', nativeJournal: true,
  })).toThrow('Preexisting terminal capture artifact')
  expect(readFileSync(join(run, 'observer.dylib'), 'utf8')).toBe(sentinel)
  expect(readFileSync(join(run, 'native-observer.json'), 'utf8')).toBe(enrollment)
  expect(existsSync(join(run, 'observer-compile.log'))).toBe(false)
})
test('native first seal refuses missing producer expectation without rebuilding it from cleanup', async () => {
  const launch = fixture()
  launch.capture.nativeJournal = true
  writeFileSync(join(launch.run, 'capture-eof'), '0\n')
  writeFileSync(join(launch.run, 'start.json'), JSON.stringify({ childPid: 17 }))
  writeFileSync(join(launch.run, 'broker-cleanup.json'), JSON.stringify({
    normalCompletion: true, ioClose: { recordCount: 1, sha256: 'a'.repeat(64) },
  }))
  const report = await sealBuiltinCapture(launch)
  expect(report.boundedVerdict).toBe('failed')
  expect(report.failure).toContain('producer-expected-native.json')
  expect(existsSync(join(launch.run, 'expected-native.json'))).toBe(false)
  expect(report.productTimingEquivalent).toBe(false)
  expect(report.fullNativeGatePassed).toBe(false)
})
test('paste evidence requires exact owned bytes, both successful commands and actual forwarded native input', () => {
  const launch = fixture(), path = join(launch.run, 'input.bin'),
    bytes = Buffer.from('中文\r')
  writeFileSync(path, bytes)
  const send = {
    phase: 'send', actionId: 1, transport: 'tmux-paste-buffer',
    target: launch.target, buffer: 'owned',
    inputFile: path, hex: bytes.toString('hex'),
    bytesSHA256: createHash('sha256').update(bytes).digest('hex'),
    actualCommands: [
      ['load-buffer', '-b', 'owned', path],
      ['paste-buffer', '-b', 'owned', '-t', launch.target],
    ],
  }, sent = { phase: 'sent', actionId: 1, exitCodes: [0, 0] },
    io = [{ kind: 'input', hex: send.hex.slice(0, 6) },
          { kind: 'input', hex: send.hex.slice(6) }]
  expect(validateCaptureInputs(launch.run, launch.target, [send, sent], io)).toBe(true)
  for (const observed of [[], [{ kind: 'input', hex: '0d' }], [...io, ...io]])
    expect(validateCaptureInputs(launch.run, launch.target, [send, sent], observed)).toBe(false)
  expect(validateCaptureInputs(launch.run, launch.target, [send,
    { ...sent, exitCodes: [0, 1] }], io)).toBe(false)
  writeFileSync(path, 'different')
  expect(validateCaptureInputs(launch.run, launch.target, [send, sent], io)).toBe(false)
})
test('capture cannot release native startup before the recorder is active', () => {
  const launch = fixture()
  let calls = []
  installBuiltinCapture(launch, launch.capture, (_file, args) => {
    calls.push(args)
    expect(existsSync(launch.capture.ready)).toBe(false)
    return args.includes('display-message') ? '1\n' : ''
  })
  expect(calls[0]).toContain('pipe-pane')
  expect(calls[0]).toContain(launch.capture.collector)
  expect(existsSync(launch.capture.ready)).toBe(true)
  const failed = fixture()
  calls = []
  expect(() =>
    installBuiltinCapture(failed, failed.capture, (_file, args) => {
      calls.push(args)
      return '0\n'
    }),
  ).toThrow('recorder was not installed')
  expect(existsSync(failed.capture.ready)).toBe(false)
  expect(calls.at(-1)).toContain('kill-server')
  expect(readFileSync(launch.capture.wrapper, 'utf8')).not.toContain(
    'stty -onlcr',
  )
})
test('actual sends use exact hex chunks and preserve literal UTF-8 and chord boundaries', () => {
  const launch = fixture()
  let sent
  recordedBuiltinTmux(
    launch,
    ['send-keys', '-t', launch.target, '-l', '中文'],
    (_file, args) => {
      sent = args
      return ''
    },
  )
  expect(sent.slice(-6)).toEqual(['e4', 'b8', 'ad', 'e6', '96', '87'])
  recordedBuiltinTmux(
    launch,
    ['send-keys', '-t', launch.target, 'C-x', 'Tab'],
    (_file, args) => {
      sent = args
      return ''
    },
  )
  expect(sent.slice(-2)).toEqual(['18', '09'])
  const rows = readFileSync(join(launch.run, 'inputs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
  expect(rows.filter((r) => r.phase === 'send').map((r) => r.actionId)).toEqual(
    [1, 2],
  )
  expect(rows[0].hex).toBe('e4b8ade69687')
  expect(() => inputBytes(['send-keys', '-t', 'p', 'Unknown'])).toThrow(
    'Unrecorded',
  )
})
test('complete capture keeps empty groups and fails on reordered or dropped raw bytes', async () => {
  const launch = fixture()
  writeFileSync(launch.capture.eof, '0\n')
  writeFileSync(join(launch.run, 'initial-termios.txt'), 'flags')
  writeFileSync(join(launch.run, 'inputs.jsonl'), '{}\n')
  writeFileSync(launch.capture.raw, 'ABtail')
  writeFileSync(
    launch.capture.frames,
    [
      { frameId: 1, outputBase64: Buffer.from('A').toString('base64') },
      { frameId: 2, outputBase64: '' },
      { frameId: 3, outputBase64: Buffer.from('B').toString('base64') },
    ]
      .map(JSON.stringify)
      .join('\n') + '\n',
  )
  const report = await sealBuiltinCapture(launch, 1)
  expect(report.stream.verdict).toBe('passed')
  expect(report.stream.intervals[1]).toEqual({
    frameId: 2,
    outputGroupId: 2,
    start: 1,
    end: 1,
  })
  expect(report.stream.tailBytes).toBe(4)
  expect(report.framePhysicalVerdict).toBe('not covered')
  const dropped = fixture()
  writeFileSync(dropped.capture.eof, '0\n')
  writeFileSync(dropped.capture.raw, 'B')
  writeFileSync(
    dropped.capture.frames,
    JSON.stringify({
      frameId: 1,
      outputBase64: Buffer.from('AB').toString('base64'),
    }) + '\n',
  )
  const bad = await sealBuiltinCapture(dropped, 1)
  expect(bad.stream.verdict).toBe('failed')
  expect(bad.stream.firstDifference.offset).toBe(0)
})
test('missing EOF and malformed sealed frames never become successful evidence', async () => {
  const launch = fixture()
  const failed = await sealBuiltinCapture(launch, 1)
  expect(failed.eofPassed).toBe(false)
  expect(failed.verdict).toBe('failed')
  const malformed = fixture()
  writeFileSync(malformed.capture.eof, '0\n')
  writeFileSync(malformed.capture.frames, '{invalid\n')
  await expect(sealBuiltinCapture(malformed, 1)).rejects.toThrow()
})
test('duplicate, missing and reordered frame IDs cannot certify a complete stream', async () => {
  for (const ids of [
    [1, 1],
    [1, 3],
    [2, 1],
  ]) {
    const launch = fixture()
    writeFileSync(launch.capture.eof, '0\n')
    writeFileSync(launch.capture.raw, 'AB')
    writeFileSync(
      launch.capture.frames,
      ids
        .map((frameId, i) =>
          JSON.stringify({
            frameId,
            outputBase64: Buffer.from(i ? 'B' : 'A').toString('base64'),
          }),
        )
        .join('\n') + '\n',
    )
    const result = await sealBuiltinCapture(launch, 1)
    expect(result.stream.verdict).toBe('failed')
    expect(result.stream.firstDifference.reason).toContain('frame ID')
  }
})
