import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getCwd } from './cwd.js'
import { changeSessionCwd } from './cwdChange.js'
import { setCwd } from './Shell.js'

const originalCwd = getCwd()
const tempRoot = await mkdtemp(join(tmpdir(), 'cwd-change-test-'))
const next = join(tempRoot, 'next')
const nested = join(next, 'nested')
await mkdir(nested, { recursive: true })
const physicalRoot = await realpath(tempRoot)
const physicalNext = await realpath(next)
await writeFile(join(tempRoot, 'file.txt'), 'not a directory')

let cacheClears = 0
let envInvalidations = 0
const hookCalls: Array<{ oldCwd: string; newCwd: string }> = []

try {
  setCwd(physicalRoot)
  const changed = changeSessionCwd('next', {
    relativeTo: physicalRoot,
    clearCommandCaches: () => {
      cacheClears += 1
    },
    invalidateEnv: () => {
      envInvalidations += 1
    },
    notifyHooks: (oldCwd, newCwd) => {
      hookCalls.push({ oldCwd, newCwd })
    },
  })

  assert.equal(changed, physicalNext)
  assert.equal(getCwd(), physicalNext)
  assert.equal(cacheClears, 1)
  assert.equal(envInvalidations, 1)
  assert.deepEqual(hookCalls, [{ oldCwd: physicalRoot, newCwd: physicalNext }])

  const changedWithoutCacheClear = changeSessionCwd(physicalRoot, {
    clearCommandCaches: () => {
      cacheClears += 1
    },
    shouldClearCommandCaches: false,
    invalidateEnv: () => {
      envInvalidations += 1
    },
    notifyHooks: (oldCwd, newCwd) => {
      hookCalls.push({ oldCwd, newCwd })
    },
  })
  assert.equal(changedWithoutCacheClear, physicalRoot)
  assert.equal(cacheClears, 1)
  assert.equal(envInvalidations, 2)

  assert.throws(() => changeSessionCwd(join(physicalRoot, 'missing')), /does not exist/)
  assert.equal(getCwd(), physicalRoot)

  assert.throws(
    () => changeSessionCwd(join(physicalRoot, 'file.txt')),
    /is not a directory/,
  )
  assert.equal(getCwd(), physicalRoot)
} finally {
  setCwd(originalCwd)
}

console.log('cwdChange.test.ts passed')
