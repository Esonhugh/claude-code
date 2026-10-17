import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_MCP_LIST_PAGINATION_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('MCP list requests follow nextCursor (isolated)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-mcp-pagination-')))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SHELL_PREFIX)/.test(key)))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        env: {...env, [childFlag]:'1', HOME:root, CLAUDE_CONFIG_DIR:root,
          ANTHROPIC_API_KEY:'test-only-placeholder', DISABLE_TELEMETRY:'1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},
        stdout:'pipe', stderr:'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
      if (code !== 0) throw new Error(stdout + '\n' + stderr)
      console.log((stdout + stderr).match(/\d+ pass[\s\S]*?Ran [^\n]+/)?.[0])
    } finally { rmSync(root,{recursive:true,force:true}) }
  },30_000)
} else {
  ;(globalThis as typeof globalThis & {MACRO:{VERSION:string}}).MACRO = {VERSION:'test'}
  const { connectToServer, clearServerCache, fetchToolsForClient, fetchResourcesForClient, fetchCommandsForClient } = await import('./client.js')

  // pages: number of pages the fixture serves per list method (Infinity = never stops).
  async function withPagingServer(pages: number, run: (connection: import('./types.js').MCPServerConnection) => Promise<void>) {
    const root = realpathSync(mkdtempSync(join(tmpdir(),'cc-mcp-paging-')))
    const file = join(root,'server.mjs')
    writeFileSync(file,`
      const pages = ${pages === Infinity ? 'Infinity' : pages}
      const item = {
        'tools/list': (p) => ({ tools: [{ name: 'tool_' + p, inputSchema: { type: 'object' } }] }),
        'resources/list': (p) => ({ resources: [{ uri: 'owned://r/' + p, name: 'resource_' + p }] }),
        'prompts/list': (p) => ({ prompts: [{ name: 'prompt_' + p }] }),
      }
      let buffer = ''
      process.stdin.on('data',chunk => {
        buffer += chunk
        let end
        while ((end = buffer.indexOf('\\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0,end))
          buffer = buffer.slice(end + 1)
          let result
          if (message.method === 'initialize') {
            result = {protocolVersion:message.params.protocolVersion,capabilities:{tools:{},resources:{},prompts:{}},serverInfo:{name:'pager',version:'1'}}
          } else if (item[message.method]) {
            const page = Number(message.params?.cursor ?? 0)
            result = item[message.method](page)
            if (page + 1 < pages) result.nextCursor = String(page + 1)
          }
          if (message.id === undefined) continue
          process.stdout.write(JSON.stringify(result ? {jsonrpc:'2.0',id:message.id,result} : {jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}})+'\\n')
        }
      })
    `)
    const config: import('./types.js').ScopedMcpServerConfig = {type:'stdio',command:process.execPath,args:[file],scope:'dynamic'}
    const name = 'pager-' + root.split('/').at(-1)
    try {
      const connection = await connectToServer(name,config)
      expect(connection.type).toBe('connected')
      await run(connection)
    } finally {
      await clearServerCache(name,config)
      rmSync(root,{recursive:true,force:true})
    }
  }

  test('tools/list, resources/list and prompts/list collect every page', async () => {
    await withPagingServer(3, async connection => {
      const tools = await fetchToolsForClient(connection)
      expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['tool_0','tool_1','tool_2'])
      const resources = await fetchResourcesForClient(connection)
      expect(resources.map(r => r.name)).toEqual(['resource_0','resource_1','resource_2'])
      const commands = await fetchCommandsForClient(connection)
      expect(commands.map(c => c.name.split('__').at(-1))).toEqual(['prompt_0','prompt_1','prompt_2'])
    })
  },10_000)

  test('a server that never stops returning nextCursor is capped at 20 pages', async () => {
    // Official 2.1.292 stops after 20 pages and keeps the items collected so far.
    await withPagingServer(Infinity, async connection => {
      const tools = await fetchToolsForClient(connection)
      expect(tools).toHaveLength(20)
      expect(tools.at(-1)?.mcpInfo?.toolName).toBe('tool_19')
    })
  },10_000)
}
