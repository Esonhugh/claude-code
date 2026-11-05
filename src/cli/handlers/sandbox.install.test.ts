import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals
const { warmWindowsSandboxProfile } = await import('./sandbox.js')

const dir = mkdtempSync(join(tmpdir(), 'cc-sandbox-warm-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// Stands in for srt-win: records its args, connects to the target, exits 3.
const fakeSrtWin = join(dir, 'fake-srt-win.ts')
const argsFile = join(dir, 'args.json')
writeFileSync(
  fakeSrtWin,
  `import { connect } from 'node:net'
const args = process.argv.slice(2)
await Bun.write(${JSON.stringify(argsFile)}, JSON.stringify(args))
const [host, port] = args[args.indexOf('--target') + 1].split(':')
const socket = connect(Number(port), host)
socket.once('connect', () => { socket.end(); process.exit(3) })
socket.once('error', () => process.exit(9))
`,
)

test('warm-up runs `wfp verify` against a live local listener and returns its exit code', async () => {
  const code = await warmWindowsSandboxProfile({ exe: process.execPath, prependArgs: [fakeSrtWin] })
  expect(code).toBe(3)
  const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  expect(args.slice(0, 3)).toEqual(['wfp', 'verify', '--target'])
  expect(args[3]).toMatch(/^127\.0\.0\.1:\d+$/)
})

test('warm-up returns null when srt-win cannot be spawned', async () => {
  expect(await warmWindowsSandboxProfile({ exe: join(dir, 'missing.exe'), prependArgs: [] })).toBeNull()
})
