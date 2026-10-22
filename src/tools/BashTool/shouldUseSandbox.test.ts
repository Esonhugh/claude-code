import { afterAll, expect, spyOn, test } from 'bun:test'
;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}
const { setSessionSettingsCache } =
  await import('../../utils/settings/settingsCache.js')
const { SandboxManager } = await import('../../utils/sandbox/sandbox-adapter.js')
const { shouldUseSandbox } = await import('./shouldUseSandbox.js')

const enabled = spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(
  true,
)
afterAll(() => {
  enabled.mockRestore()
  setSessionSettingsCache({ settings: {}, errors: [] })
})

test('excludedCommands exempts a compound command only when every part matches', () => {
  setSessionSettingsCache({
    settings: { sandbox: { excludedCommands: ['bazel:*', 'docker ps'] } },
    errors: [],
  })
  for (const command of [
    'bazel build //x',
    'timeout 30 bazel test //x',
    'bazel build //x && bazel test //x',
    'docker ps && bazel info',
  ]) {
    expect({ command, sandboxed: shouldUseSandbox({ command }) }).toEqual({
      command,
      sandboxed: false,
    })
  }
  for (const command of [
    'bazel build //x && curl https://example.com',
    'docker ps; rm -rf ~/x',
    'echo hi | bazel run //x',
    'ls',
  ]) {
    expect({ command, sandboxed: shouldUseSandbox({ command }) }).toEqual({
      command,
      sandboxed: true,
    })
  }
})
