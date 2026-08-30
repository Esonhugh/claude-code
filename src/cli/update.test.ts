import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: '2.1.666',
  PACKAGE_URL: '@esonhugh/claude-code',
  NATIVE_PACKAGE_URL: null,
}

let stdout = ''
let stderr = ''
let nativeInstallCalled = false
let nativeInstallResult = { latestVersion: '2.1.667', wasUpdated: true }
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
    return nativeInstallResult
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
  nativeInstallResult = { latestVersion: '2.1.667', wasUpdated: true }
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
  test('updates native installations from the native release channel', async () => {
    const { update } = await import('./update.js')

    await expect(update()).rejects.toBe(shutdownSentinel)

    expect(nativeInstallCalled).toBe(true)
    expect(stdout + stderr).toContain(
      'Successfully updated from 2.1.666 to version 2.1.667',
    )
    expect(shutdownCode).toBe(0)
  })

  test('reports native installations that are already current', async () => {
    nativeInstallResult = { latestVersion: '2.1.666', wasUpdated: false }
    const { update } = await import('./update.js')

    await expect(update()).rejects.toBe(shutdownSentinel)

    expect(nativeInstallCalled).toBe(true)
    expect(stdout + stderr).toContain('Claude Code is up to date (2.1.666)')
    expect(shutdownCode).toBe(0)
  })
})
