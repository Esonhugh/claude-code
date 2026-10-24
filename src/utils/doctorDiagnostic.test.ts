import { afterEach, describe, expect, test } from 'bun:test'
import {
  detectManagedSandboxIgnoredWarnings,
  getCurrentInstallationType,
} from './doctorDiagnostic.js'
import { getSettingsFilePathForSource } from './settings/settings.js'
import {
  resetSettingsCache,
  setCachedSettingsForSource,
} from './settings/settingsCache.js'

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

describe('detectManagedSandboxIgnoredWarnings', () => {
  afterEach(() => {
    resetSettingsCache()
  })

  test('warns about user allowRead/allowedDomains ignored by managed-only policy', () => {
    setCachedSettingsForSource('policySettings', {
      sandbox: {
        network: { allowManagedDomainsOnly: true, allowedDomains: ['corp.example'] },
        filesystem: { allowManagedReadPathsOnly: true },
      },
    })
    setCachedSettingsForSource('userSettings', {
      sandbox: {
        network: { allowedDomains: ['user.example'] },
        filesystem: { allowRead: ['/opt'] },
      },
    })

    const issues = detectManagedSandboxIgnoredWarnings().map(w => w.issue)
    const userPath = getSettingsFilePathForSource('userSettings')
    expect(issues).toEqual([
      `sandbox.filesystem.allowRead is ignored — managed settings set allowManagedReadPathsOnly, so only allowRead paths from managed settings are honored. The entry in ${userPath} will NOT apply (see https://code.claude.com/docs/en/settings#sandbox-settings).`,
      `sandbox.network.allowedDomains is ignored — managed settings set allowManagedDomainsOnly, so only allowed domains (and WebFetch domain rules) from managed settings are honored. The entry in ${userPath} will NOT apply (see https://code.claude.com/docs/en/settings#sandbox-settings).`,
    ])
  })

  test('no warning without the managed-only flags', () => {
    setCachedSettingsForSource('policySettings', {
      sandbox: { network: { allowedDomains: ['corp.example'] } },
    })
    setCachedSettingsForSource('userSettings', {
      sandbox: { network: { allowedDomains: ['user.example'] } },
    })
    expect(detectManagedSandboxIgnoredWarnings()).toEqual([])
  })
})
