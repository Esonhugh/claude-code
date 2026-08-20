import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { it } from 'bun:test'

const source = readFileSync(new URL('./print.ts', import.meta.url), 'utf8')

it('routes managed SSH controls and targeted cancellation outside model turns', () => {
  assert.match(source, /new ManagedSSHControlService\(\{[\s\S]{0,300}getHistory: \(\) => mutableMessages/)
  assert.match(source, /managedSSHControl\.handleRequest\(message\)/)
  assert.match(
    source,
    /message\.type === 'control_cancel_request'[\s\S]{0,160}managedSSHControl\.cancel\(message\.request_id\)/,
  )
  assert.match(source, /inputClosed = true[\s\S]{0,120}managedSSHControl\.shutdown\(\)/)
})
