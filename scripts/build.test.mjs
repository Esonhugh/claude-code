#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { copyRuntimeAssets } from './build.mjs'

const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-build-test-'))
const projectDir = path.join(tempDir, 'project')
const nodeModulesDir = path.join(projectDir, 'node_modules')

const nodePtyPrebuildDir = path.join(
  nodeModulesDir,
  'node-pty',
  'prebuilds',
  `${process.platform}-${process.arch}`,
)
const ripgrepSourceDir = path.join(
  nodeModulesDir,
  '@anthropic-ai',
  'ripgrep',
  `${process.arch}-${process.platform}`,
)
await fs.promises.mkdir(nodePtyPrebuildDir, { recursive: true })
await fs.promises.mkdir(ripgrepSourceDir, { recursive: true })
await fs.promises.writeFile(path.join(nodePtyPrebuildDir, 'pty.node'), 'pty')
await fs.promises.writeFile(path.join(ripgrepSourceDir, 'rg'), 'rg')

await copyRuntimeAssets({ projectDir, nodeModulesDir })

assert.equal(
  await fs.promises.readFile(
    path.join(
      projectDir,
      'dist',
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'pty.node',
    ),
    'utf8',
  ),
  'pty',
)
assert.equal(
  await fs.promises.readFile(
    path.join(
      projectDir,
      'dist',
      'vendor',
      'ripgrep',
      `${process.arch}-${process.platform}`,
      'rg',
    ),
    'utf8',
  ),
  'rg',
)

await fs.promises.rm(tempDir, { recursive: true, force: true })

console.log('build.test.mjs passed')
