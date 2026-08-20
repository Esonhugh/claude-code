import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'bun:test'

const replSource = readFileSync(
  new URL('../screens/REPL.tsx', import.meta.url),
  'utf8',
)

test('keeps SSH transcripts remote-owned while wiring remote file completion', () => {
  assert.match(
    replSource,
    /useLogMessages\(\s*messages,\s*sshRemote\.isRemoteMode \|\|/,
  )
  assert.match(
    replSource,
    /remoteFileSuggestionProvider=\{\s*sshRemote\.isRemoteMode\s*\? sshRemote\.remoteFileSuggestionProvider/,
  )
  assert.match(
    replSource,
    /enableLocalIOCompletions=\{!isRemoteExecutionSession\}/,
  )
})
