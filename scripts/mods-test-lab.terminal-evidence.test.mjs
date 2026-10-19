import { expect, mock, test } from 'bun:test'
import * as evidence from './builtin-terminal-evidence.mjs'

// Native captures are closed by the native validator; the legacy one only knows PTY-recorder files.
const validated = []
mock.module('./builtin-terminal-evidence.mjs', () => ({
  ...evidence,
  validateNativeTerminalEvidence: side => { validated.push(['native', side.name]); return true },
  validateBuiltinTerminalEvidence: side => { validated.push(['legacy', side.name]); return false },
}))
const { assessBuiltinAcceptance } = await import('./mods-test-lab.mjs')

const names = ['privacyOff', 'privacyOn', 'enabled', 'disabled', 'securityOrdinary', 'securityTeam', 'securityEnterprise']
const pair = backend => Object.fromEntries(names.map(name => [name, {
  name, binarySha256: 'a'.repeat(64), requests: [], ledger: [],
  cleanup: { terminalCapture: { ...(backend ? { backend } : {}), productTimingEquivalent: false } },
}]))

test('native captures are judged by the native validator, others by the legacy one', () => {
  validated.length = 0
  const native = assessBuiltinAcceptance(pair('native-shared-slot-v1')).terminalEvidence
  expect(validated.every(([kind]) => kind === 'native')).toBe(true)
  expect(native.frameEvidence).toBe(true)
  // Product timing is still not preserved, so the gate stays closed.
  expect(native.timingEquivalent).toBe(false)
  expect(native.verdict).toBe('failed')

  validated.length = 0
  const legacy = assessBuiltinAcceptance(pair(undefined)).terminalEvidence
  expect(validated.every(([kind]) => kind === 'legacy')).toBe(true)
  expect(legacy.frameEvidence).toBe(false)
})
