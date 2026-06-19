import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getCwd } from '../../utils/cwd.js'
import { setCwd } from '../../utils/Shell.js'
import { executeCd } from './cd.js'

const originalCwd = getCwd()
const tempRoot = await mkdtemp(join(tmpdir(), 'cd-command-test-'))
const next = join(tempRoot, 'next')
await mkdir(next, { recursive: true })
const physicalRoot = await realpath(tempRoot)
const physicalNext = await realpath(next)

let cacheClears = 0
let envInvalidations = 0
const hookCalls: Array<{ oldCwd: string; newCwd: string }> = []

try {
  setCwd(physicalRoot)

  assert.equal(executeCd('').message, 'Usage: /cd <path>')
  assert.equal(getCwd(), physicalRoot)

  const changed = executeCd('next', {
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

  assert.equal(changed.message, `Changed directory to ${physicalNext}`)
  assert.equal(getCwd(), physicalNext)
  assert.equal(cacheClears, 1)
  assert.equal(envInvalidations, 1)
  assert.deepEqual(hookCalls, [{ oldCwd: physicalRoot, newCwd: physicalNext }])

  const quoted = executeCd(`"${physicalRoot}"`, {
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
  assert.equal(quoted.message, `Changed directory to ${physicalRoot}`)
  assert.equal(getCwd(), physicalRoot)

  assert.match(executeCd(join(physicalRoot, 'missing')).message, /does not exist/)
  assert.equal(getCwd(), physicalRoot)
} finally {
  setCwd(originalCwd)
}

console.log('cd.test.ts passed')
