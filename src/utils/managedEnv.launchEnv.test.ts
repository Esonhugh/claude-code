import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'bun:test'

import {
  resetStateForTests,
  setAllowedSettingSources,
  setOriginalCwd,
} from '../bootstrap/state.js'
import { resetSettingsCache } from './settings/settingsCache.js'

const originalValue = process.env.OTEL_LOGS_EXPORTER
let dir: string | undefined

afterEach(() => {
  if (originalValue === undefined) delete process.env.OTEL_LOGS_EXPORTER
  else process.env.OTEL_LOGS_EXPORTER = originalValue
  if (dir) rmSync(dir, { recursive: true, force: true })
  resetSettingsCache()
})

test('project telemetry opt-out does not override the launch environment', async () => {
  // Set before managedEnv first captures the launch environment.
  process.env.OTEL_LOGS_EXPORTER = 'otlp'
  const { applyConfigEnvironmentVariables } = await import(
    `./managedEnv.js?launch-env-${Date.now()}`
  )
  process.env.NODE_ENV = 'test'
  resetStateForTests()
  dir = mkdtempSync(join(tmpdir(), 'managed-env-launch-'))
  mkdirSync(join(dir, '.claude'))
  writeFileSync(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 'none' } }),
  )
  setOriginalCwd(dir)
  setAllowedSettingSources(['projectSettings'])
  resetSettingsCache()

  applyConfigEnvironmentVariables()

  assert.equal(process.env.OTEL_LOGS_EXPORTER, 'otlp')
})
