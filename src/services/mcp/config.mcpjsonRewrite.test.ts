import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_MCPJSON_REWRITE_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  // Settings and config are cached per process.
  test('.mcp.json rewrite (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-mcpjson-home-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT)/.test(key)))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home, MCPJSON_TEST_SECRET: 'topsecret-value',
          DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 120_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' } as MacroGlobals
  const { setCwdState, setOriginalCwd } = await import('../../bootstrap/state.js')
  const { addMcpConfig, removeMcpConfig } = await import('./config.js')

  const written = {
    $schema: 'x',
    mcpServers: {
      keep: { command: 'node', args: ['srv.js'], env: { TOKEN: '${MCPJSON_TEST_SECRET}' } },
      future: { type: 'futuretype', url: 'http://x' },
    },
    other: [1, 2],
  }
  const added = { type: 'stdio', command: 'echo', args: ['hi'], env: {} }
  const malformed = '.mcp.json is malformed (not valid JSON, or mcpServers is not an object)'

  function project(content?: string) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-mcpjson-project-')))
    if (content !== undefined) writeFileSync(join(dir, '.mcp.json'), content)
    setOriginalCwd(dir)
    setCwdState(dir)
    process.chdir(dir)
    return join(dir, '.mcp.json')
  }
  const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

  test('adding a server keeps ${VAR} references, other keys and entries of an unknown type', async () => {
    const file = project(JSON.stringify(written))
    await addMcpConfig('new1', added, 'project')
    expect(read(file)).toEqual({ ...written, mcpServers: { ...written.mcpServers, new1: added } })
    expect(Object.keys(read(file))).toEqual(['$schema', 'mcpServers', 'other'])
  })

  test('removing a server keeps the rest as written', async () => {
    const file = project(JSON.stringify(written))
    await removeMcpConfig('keep', 'project')
    expect(read(file)).toEqual({ ...written, mcpServers: { future: written.mcpServers.future } })
  })

  test('an entry of an unknown type has its name taken and can be removed', async () => {
    const file = project(JSON.stringify(written))
    await expect(addMcpConfig('future', added, 'project')).rejects.toThrow('MCP server future already exists in .mcp.json')
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(written))
    await removeMcpConfig('future', 'project')
    expect(read(file)).toEqual({ ...written, mcpServers: { keep: written.mcpServers.keep } })
  })

  test('a malformed .mcp.json is left alone', async () => {
    for (const content of ['{"mcpServers": {"a": {"command":"x"},}\n', '{"mcpServers":[]}', '{"mcpServers":null}', '[]']) {
      const file = project(content)
      await expect(addMcpConfig('new1', added, 'project')).rejects.toThrow(malformed)
      await expect(removeMcpConfig('a', 'project')).rejects.toThrow(malformed)
      expect(readFileSync(file, 'utf8')).toBe(content)
    }
  })

  test('a missing or blank .mcp.json starts a new one', async () => {
    for (const content of [undefined, '', '  \n ']) {
      const file = project(content)
      await expect(removeMcpConfig('a', 'project')).rejects.toThrow('No MCP server named "a" in .mcp.json')
      await addMcpConfig('new1', added, 'project')
      expect(read(file)).toEqual({ mcpServers: { new1: added } })
    }
  })

  test('a file without mcpServers gains it', async () => {
    const file = project('\uFEFF{"x":1}')
    await addMcpConfig('new1', added, 'project')
    expect(read(file)).toEqual({ x: 1, mcpServers: { new1: added } })
  })
}
