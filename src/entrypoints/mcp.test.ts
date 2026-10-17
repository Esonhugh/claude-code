import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const serveFlag = 'CLAUDE_CODE_MCP_SERVE_TEST_SERVER'
if (process.env[serveFlag] === '1') {
  // Child process: run `claude mcp serve` over this process's stdio.
  ;(globalThis as typeof globalThis & {MACRO:{VERSION:string}}).MACRO = {VERSION:'test'}
  const { startMCPServer } = await import('./mcp.js')
  await startMCPServer(process.cwd(), false, false)
} else {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const alive = (pid: number) => { try { process.kill(pid,0); return true } catch { return false } }

  async function withServe(run: (client: InstanceType<typeof Client>, work: string) => Promise<void>) {
    const root = realpathSync(mkdtempSync(join(tmpdir(),'cc-mcp-serve-')))
    const work = join(root,'work')
    mkdirSync(work)
    writeFileSync(join(work,'a.txt'),'owned fixture\n')
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SHELL_PREFIX)/.test(key))) as Record<string,string>
    const transport = new StdioClientTransport({
      command: process.execPath, args: [import.meta.path], cwd: work, stderr: 'pipe',
      env: {...env, [serveFlag]:'1', HOME:root, CLAUDE_CONFIG_DIR:root,
        ANTHROPIC_API_KEY:'test-only-placeholder', DISABLE_TELEMETRY:'1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},
    })
    const client = new Client({ name: 'owned-serve-test', version: '1' })
    try {
      await client.connect(transport)
      await run(client, work)
    } finally {
      await client.close()
      rmSync(root,{recursive:true,force:true})
    }
  }

  test('mcp serve results are usable by MCP SDK clients and arguments are schema-validated', async () => {
    await withServe(async (client, work) => {
      const { tools } = await client.listTools()
      expect(tools.length).toBeGreaterThan(0)
      // Official 2.1.292 advertises outputSchema: undefined; results carry no structuredContent,
      // so an advertised outputSchema makes SDK clients reject every call with -32600.
      expect(tools.filter(t => t.outputSchema).map(t => t.name)).toEqual([])

      const ok = await client.callTool({ name: 'Glob', arguments: { pattern: '*.txt' } })
      expect(ok.isError).toBeFalsy()
      expect(JSON.parse((ok.content as Array<{type:string,text:string}>)[0]!.text).filenames).toEqual(['a.txt'])

      const invalid = await client.callTool({ name: 'Glob', arguments: { pattern: 123 } })
      expect(invalid.isError).toBe(true)
      const text = (invalid.content as Array<{type:string,text:string}>)[0]!.text
      expect(text.startsWith('Tool Glob arguments failed schema validation: ')).toBe(true)
    })
  },30_000)

  test('cancelling an mcp serve request aborts the running tool', async () => {
    await withServe(async (client, work) => {
      const pidFile = join(work,'pid')
      const controller = new AbortController()
      const call = client.callTool(
        { name: 'Bash', arguments: { command: `echo $$ > ${pidFile}; sleep 30`, description: 'owned sleep' } },
        undefined,
        { signal: controller.signal, timeout: 60_000 },
      ).catch(error => error)
      let pid = 0
      for (let i = 0; i < 200 && !pid; i++) {
        await Bun.sleep(50)
        try { pid = Number(readFileSync(pidFile,'utf8').trim()) } catch { /* not written yet */ }
      }
      expect(pid).toBeGreaterThan(0)
      try {
        controller.abort()
        await call
        const deadline = Date.now() + 5000
        while (alive(pid) && Date.now() < deadline) await Bun.sleep(50)
        expect(alive(pid)).toBe(false)
      } finally {
        if (alive(pid)) process.kill(pid,'SIGKILL')
      }
    })
  },60_000)
}
