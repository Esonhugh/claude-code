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

async function runBuilt(command: string): Promise<string> {
  const provider = await createBashShellProvider('/bin/bash', { skipSnapshot: true })
  const { commandString } = await provider.buildExecCommand(command, { id: `t${Math.random()}`, useSandbox: false })
  // stdin stays an open pipe, like the Bash tool's spawn
  const proc = Bun.spawn(['/bin/bash', '-c', commandString], { stdin: 'pipe', stdout: 'pipe' })
  const out = await Promise.race([
    new Response(proc.stdout).text(),
    Bun.sleep(2000).then(() => 'HUNG'),
  ])
  proc.kill()
  return out
}

test('every command in a list or pipeline reads /dev/null, not the open stdin pipe', async () => {
  expect(await runBuilt('read v; echo got:$v')).toBe('got:\n')
  expect(await runBuilt('echo a; read v | cat; echo b')).toBe('a\nb\n')
})

test('single-quoted ! stays literal', async () => {
  expect(await runBuilt("echo '.x != 1' 'feat!: y'")).toBe('.x != 1 feat!: y\n')
  expect(await runBuilt("echo '.x != 1' | cat")).toBe('.x != 1\n')
})
