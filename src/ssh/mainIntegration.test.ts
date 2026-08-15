import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'bun:test'

const source = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')
const replSource = readFileSync(new URL('../screens/REPL.tsx', import.meta.url), 'utf8')

test('awaits local SSH session creation before reading the session', () => {
  assert.match(
    source,
    /sshSession = await createLocalSSHSession\(\{/,
  )
})

test('accepts root flags before ssh without treating flag values as the subcommand', () => {
  assert.match(source, /rootFlagsWithValues = new Set\(\[/)
  assert.match(source, /'--debug-file'/)
  assert.match(source, /'--model'/)
  assert.match(source, /if \(arg === '--' \|\| !arg\.startsWith\('-'\)\) break/)
  assert.match(
    source,
    /'ssh',\s+\.\.\.rawCliArgs\.slice\(sshIndex \+ 1\),\s+\.\.\.rootFlags/,
  )
  assert.doesNotMatch(source, /rawCliArgs\.indexOf\('ssh'\)/)
})

test('only trusts adjacent development SSH artifacts', () => {
  const sshSource = readFileSync(
    new URL('./createSSHSession.ts', import.meta.url),
    'utf8',
  )
  assert.match(sshSource, /dirname\(process\.execPath\)/)
  assert.doesNotMatch(
    sshSource,
    /join\(\s*process\.cwd\(\),\s*'dist',\s*'release'/,
  )
})

test('creates an abort controller before sending a remote prompt', () => {
  assert.match(
    replSource,
    /const remoteAbortController = createAbortController\(\)\s+setAbortController\(remoteAbortController\)[\s\S]{0,80}await activeRemote\.sendMessage/,
  )
})

test('only keeps remote cancel active while the remote turn is loading', () => {
  assert.match(
    replSource,
    /abortSignal:\s+activeRemote\.isRemoteMode && !isLoading\s+\? undefined\s+: abortController\?\.signal/,
  )
})
