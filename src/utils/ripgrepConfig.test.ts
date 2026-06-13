import assert from 'node:assert/strict'
import path from 'node:path'

import { resolveRipgrepConfig } from './ripgrepConfig.js'

const base = {
  arch: 'arm64',
  platform: 'darwin' as NodeJS.Platform,
  dirname: '/app/dist',
  execPath: '/app/claude',
  systemRipgrepPath: '/opt/homebrew/bin/rg',
  userWantsSystemRipgrep: false,
}

assert.deepEqual(
  resolveRipgrepConfig({
    ...base,
    bundled: false,
    vendoredRipgrepExists: true,
  }),
  {
    mode: 'builtin',
    command: path.resolve('/app/dist', 'vendor', 'ripgrep', 'arm64-darwin', 'rg'),
    args: [],
  },
)

assert.deepEqual(
  resolveRipgrepConfig({
    ...base,
    bundled: false,
    vendoredRipgrepExists: false,
  }),
  {
    mode: 'system',
    command: 'rg',
    args: [],
  },
)

assert.deepEqual(
  resolveRipgrepConfig({
    ...base,
    bundled: true,
    vendoredRipgrepExists: false,
  }),
  {
    mode: 'embedded',
    command: '/app/claude',
    args: ['--no-config'],
    argv0: 'rg',
  },
)

console.log('ripgrepConfig.test.ts passed')
