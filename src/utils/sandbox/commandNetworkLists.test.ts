import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childKey = 'COMMAND_NETWORK_LISTS_TEST_CHILD'

// Other test files mock sandbox-adapter: run against the real one in a child.
if (!process.env[childKey]) {
  test('command network lists (isolated child)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-command-network-lists-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: join(import.meta.dir, '../../..'),
        env: {
          PATH: process.env.PATH,
          HOME: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          [childKey]: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
} else {
  const { z } = await import('zod/v4')
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= {
    VERSION: 'test',
  } as MacroGlobals

  const { SandboxManager } = await import('./sandbox-adapter.js')
  const { allowedDomainsInputField, validateAllowedDomains } =
    await import('./commandNetworkLists.js')
  const { exec } = await import('../Shell.js')
  const { normalizeToolInput } = await import('../api.js')
  const { BashTool } = await import('../../tools/BashTool/BashTool.js')

  const spies: { mockRestore(): void }[] = []
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
  })

  test('allowed_domains is refused for an unsandboxed command or a closed allowlist', () => {
    const input = {
      command: 'curl https://a.example',
      allowed_domains: ['a.example'],
    }
    spies.push(
      spyOn(SandboxManager, 'isAllowlistClosed').mockReturnValue(false),
    )
    expect(validateAllowedDomains({ command: 'ls' }, false)).toBeUndefined()
    expect(
      validateAllowedDomains({ ...input, allowed_domains: [] }, false),
    ).toBeUndefined()
    expect(validateAllowedDomains(input, true)).toBeUndefined()
    expect(validateAllowedDomains(input, false)).toMatchObject({
      result: false,
      message: expect.stringContaining('runs in the sandbox'),
    })
    spies.push(spyOn(SandboxManager, 'isAllowlistClosed').mockReturnValue(true))
    expect(validateAllowedDomains(input, true)).toMatchObject({
      result: false,
      message: expect.stringContaining('whole allowlist'),
    })
  })

  test('allowed_domains entries must be hosts the sandbox can match', () => {
    const schema = z.object(allowedDomainsInputField())
    for (const ok of [
      'registry.npmjs.org',
      '*.pythonhosted.org',
      '10.0.0.1:22',
      '[::1]',
    ]) {
      expect(schema.safeParse({ allowed_domains: [ok] }).success).toBe(true)
    }
    for (const bad of ['https://a.example', 'a b', 'x'.repeat(261)]) {
      expect(schema.safeParse({ allowed_domains: [bad] }).success).toBe(false)
    }
    expect(
      schema.safeParse({ allowed_domains: Array(101).fill('a.example') })
        .success,
    ).toBe(false)
  })

  test('a sandboxed command registers its list under an unguessable id until it exits', async () => {
    const wrapped: (string | undefined)[] = []
    const registered: [string, unknown][] = []
    const unregistered: string[] = []
    spies.push(
      spyOn(SandboxManager, 'wrapWithSandbox').mockImplementation(
        async (command, _shell, _config, _signal, options) => {
          wrapped.push(options?.commandId)
          return command
        },
      ),
      spyOn(SandboxManager, 'registerCommandNetworkLists').mockImplementation(
        (id, lists) => {
          registered.push([id, lists])
        },
      ),
      spyOn(SandboxManager, 'unregisterCommandNetworkLists').mockImplementation(
        id => {
          unregistered.push(id)
        },
      ),
      spyOn(SandboxManager, 'cleanupAfterCommand').mockImplementation(() => {}),
    )
    const lists = { allowedDomains: ['a.example'] }
    const run = async (networkLists?: typeof lists) => {
      const shell = await exec('true', new AbortController().signal, 'bash', {
        shouldUseSandbox: true,
        networkLists,
      })
      await shell.result
    }

    await run(lists)
    const [id, registeredLists] = registered[0]!
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(registeredLists).toEqual(lists)
    expect(wrapped).toEqual([id])
    expect(unregistered).toEqual([id])

    await run()
    expect(registered).toHaveLength(1)
    expect(wrapped[1]).toBeUndefined()
  })

  test('Bash input normalization keeps allowed_domains', () => {
    const input = {
      command: 'curl https://a.example',
      description: 'fetch',
      allowed_domains: ['a.example'],
    }
    expect(normalizeToolInput(BashTool, input)).toMatchObject({
      allowed_domains: ['a.example'],
    })
  })
}
