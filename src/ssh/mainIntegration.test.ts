import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'bun:test'
import { parseRootSSHArgv } from './rootSSHArgv.js'

const source = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')
const replSource = readFileSync(new URL('../screens/REPL.tsx', import.meta.url), 'utf8')

test('awaits local SSH session creation before reading the session', () => {
  assert.match(
    source,
    /sshSession = await createLocalSSHSession\(\{/,
  )
})

test('forwards the resolved local model to the remote SSH child', () => {
  assert.match(source, /model: resolvedInitialModel/)
})

test('accepts root flags before ssh without treating flag values as the subcommand', () => {
  assert.deepEqual(
    parseRootSSHArgv([
      '--debug-file',
      'ssh',
      '--model',
      'gateway-model',
      'ssh',
      'prod',
      '/srv/project',
      '--permission-mode=acceptEdits',
    ]),
    {
      type: 'ssh',
      pending: {
        host: 'prod',
        cwd: '/srv/project',
        permissionMode: 'acceptEdits',
        dangerouslySkipPermissions: false,
        allowDangerouslySkipPermissions: false,
        local: false,
        extraCliArgs: ['--model', 'gateway-model'],
      },
      remainingArgs: ['--debug-file', 'ssh'],
    },
  )
})

test('extracts SSH-specific flags on either side of the host', () => {
  assert.deepEqual(
    parseRootSSHArgv([
      'ssh',
      '--local',
      '--permission-mode',
      'auto',
      '--dangerously-skip-permissions',
      'host.example',
      '/work',
      '--resume',
      'session-id',
      '--model=opus',
      '-c',
    ]),
    {
      type: 'ssh',
      pending: {
        host: 'host.example',
        cwd: '/work',
        permissionMode: 'auto',
        dangerouslySkipPermissions: true,
        allowDangerouslySkipPermissions: false,
        local: true,
        extraCliArgs: [
          '--continue',
          '--resume',
          'session-id',
          '--model',
          'opus',
        ],
      },
      remainingArgs: [],
    },
  )
})

test('preserves opt-in permission switching on both SSH processes', () => {
  assert.deepEqual(
    parseRootSSHArgv([
      'ssh',
      'host.example',
      '--allow-dangerously-skip-permissions',
    ]),
    {
      type: 'ssh',
      pending: {
        host: 'host.example',
        cwd: undefined,
        permissionMode: undefined,
        dangerouslySkipPermissions: false,
        allowDangerouslySkipPermissions: true,
        local: false,
        extraCliArgs: [],
      },
      remainingArgs: [],
    },
  )
  assert.match(
    source,
    /pending\.allowDangerouslySkipPermissions[\s\S]{0,100}--allow-dangerously-skip-permissions/,
  )
})

test('does not expose bypass in the local Shift+Tab cycle without opt-in', () => {
  assert.match(
    source,
    /permissionMode,\s+allowDangerouslySkipPermissions,\s+addDirs: addDir/,
  )
  assert.doesNotMatch(
    source,
    /allowDangerouslySkipPermissions\s*\|\|\s*\(feature\('SSH_REMOTE'\)/,
  )
})

test('keeps explicit /yolo available independently of the Shift+Tab opt-in', () => {
  assert.match(
    replSource,
    /mode === 'bypassPermissions'[\s\S]{0,160}isBypassPermissionsModeAvailable: true/,
  )
})

test('synchronizes Shift+Tab permission mode changes to the SSH child', () => {
  assert.match(
    replSource,
    /sshRemote\.isRemoteMode[\s\S]{0,300}\.setPermissionMode\(context\.mode\)/,
  )
})

test('rejects headless SSH and ignores non-command ssh arguments', () => {
  assert.deepEqual(parseRootSSHArgv(['--print', 'ssh', 'host.example']), {
    type: 'error',
    message:
      'Error: headless (-p/--print) mode is not supported with claude ssh\n',
  })
  assert.deepEqual(parseRootSSHArgv(['--', 'ssh', 'host.example']), {
    type: 'none',
  })
  assert.deepEqual(parseRootSSHArgv(['explain', 'ssh', 'host.example']), {
    type: 'none',
  })
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
