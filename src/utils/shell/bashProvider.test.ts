import { afterEach, expect, spyOn, test } from 'bun:test'
;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}
const { SandboxManager } = await import('../sandbox/sandbox-adapter.js')
const { createBashShellProvider } = await import('./bashProvider.js')

const originalTmpdir = process.env.TMPDIR
afterEach(() => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = originalTmpdir
})

test('unsandboxed commands get TMPDIR when sandboxing is enabled and it is unset', async () => {
  const enabled = spyOn(SandboxManager, 'isSandboxingEnabled')
  try {
    delete process.env.TMPDIR
    const provider = await createBashShellProvider('/bin/bash', {
      skipSnapshot: true,
    })
    await provider.buildExecCommand('true', { id: 1, useSandbox: false })
    enabled.mockReturnValue(true)
    expect((await provider.getEnvironmentOverrides('true')).TMPDIR).toBe('/tmp')
    enabled.mockReturnValue(false)
    expect((await provider.getEnvironmentOverrides('true')).TMPDIR).toBeUndefined()
    process.env.TMPDIR = '/custom'
    enabled.mockReturnValue(true)
    expect((await provider.getEnvironmentOverrides('true')).TMPDIR).toBeUndefined()
  } finally {
    enabled.mockRestore()
  }
})
