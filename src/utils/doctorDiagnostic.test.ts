import { afterEach, describe, expect, test } from 'bun:test'
import { getCurrentInstallationType } from './doctorDiagnostic.js'

const originalNodeEnv = process.env.NODE_ENV
const originalNpmWrapper = process.env.CLAUDE_CODE_INSTALLED_VIA_NPM_WRAPPER
const originalArgv = [...process.argv]
const originalExecPath = process.execPath

function restoreProcessState() {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv

  if (originalNpmWrapper === undefined) {
    delete process.env.CLAUDE_CODE_INSTALLED_VIA_NPM_WRAPPER
  } else {
    process.env.CLAUDE_CODE_INSTALLED_VIA_NPM_WRAPPER = originalNpmWrapper
  }

  process.argv = [...originalArgv]
  Object.defineProperty(process, 'execPath', {
    value: originalExecPath,
    configurable: true,
  })
}

afterEach(() => {
  restoreProcessState()
})

describe('getCurrentInstallationType', () => {
  test('treats a bundled binary launched by the npm wrapper as npm-global', async () => {
    process.env.NODE_ENV = 'production'
    process.env.CLAUDE_CODE_INSTALLED_VIA_NPM_WRAPPER = '1'
    process.argv = ['bun', '/$bunfs/root/claude']
    Object.defineProperty(process, 'execPath', {
      value: '/opt/homebrew/lib/node_modules/@esonhugh/claude-code/bin/claude',
      configurable: true,
    })

    await expect(getCurrentInstallationType()).resolves.toBe('npm-global')
  })
})
