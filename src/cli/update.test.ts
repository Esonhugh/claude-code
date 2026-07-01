import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: '2.1.666',
  PACKAGE_URL: '@esonhugh/claude-code',
  NATIVE_PACKAGE_URL: null,
}

let stdout = ''
let stderr = ''
let nativeInstallCalled = false
let shutdownCode: number | undefined
const shutdownSentinel = new Error('shutdown')

mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
}))

mock.module('src/utils/process.js', () => ({
  writeToStdout: (data: string) => {
    stdout += data
  },
  writeToStderr: (data: string) => {
    stderr += data
  },
}))

mock.module('src/utils/gracefulShutdown.js', () => ({
  gracefulShutdown: async (code = 0) => {
    shutdownCode = code
    throw shutdownSentinel
  },
}))

mock.module('src/utils/doctorDiagnostic.js', () => ({
  getDoctorDiagnostic: async () => ({
    installationType: 'native',
    version: '2.1.666',
    installationPath: 'native',
    invokedBinary: 'native',
    configInstallMethod: 'native',
    autoUpdates: 'enabled',
    hasUpdatePermissions: null,
    multipleInstallations: [],
    warnings: [],
    ripgrepStatus: { working: true, mode: 'builtin', systemPath: null },
  }),
}))

mock.module('src/utils/nativeInstaller/index.js', () => ({
  getPackageManager: async () => 'unknown',
  installLatest: async () => {
    nativeInstallCalled = true
    return { latestVersion: '2.1.667', wasUpdated: true }
  },
  removeInstalledSymlink: async () => {},
}))

mock.module('src/utils/settings/settings.js', () => ({
  getInitialSettings: () => ({ autoUpdatesChannel: 'latest' }),
}))

mock.module('src/utils/config.js', () => ({
  getGlobalConfig: () => ({ installMethod: 'native' }),
  saveGlobalConfig: () => {},
}))

mock.module('src/utils/autoUpdater.js', () => ({
  getLatestVersion: async () => '2.1.667',
  installGlobalPackage: async () => 'success',
}))

mock.module('src/utils/localInstaller.js', () => ({
  installOrUpdateClaudePackage: async () => 'success',
  localInstallationExists: async () => false,
}))

mock.module('src/utils/completionCache.js', () => ({
  regenerateCompletionCache: async () => {},
}))

mock.module('src/utils/userType.js', () => ({
  isAnt: () => false,
}))

const originalStderrWrite = process.stderr.write

beforeEach(() => {
  stdout = ''
  stderr = ''
  nativeInstallCalled = false
  shutdownCode = undefined
  process.stderr.write = ((data: string | Uint8Array) => {
    stderr += String(data)
    return true
  }) as typeof process.stderr.write
})

afterEach(() => {
  process.stderr.write = originalStderrWrite
})

describe('update', () => {
  test('rejects native updates and tells users to use npm or bun', async () => {
    const { update } = await import('./update.js')

    await expect(update()).rejects.toBe(shutdownSentinel)

    expect(nativeInstallCalled).toBe(false)
    expect(stdout + stderr).toContain('native installation')
    expect(stdout + stderr).toContain('npm install -g @esonhugh/claude-code')
    expect(stdout + stderr).toContain('bun install -g @esonhugh/claude-code')
    expect(shutdownCode).toBe(1)
  })
})
