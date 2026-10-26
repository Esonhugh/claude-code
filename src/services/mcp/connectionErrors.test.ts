import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_MCP_CONNECTION_ERRORS_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('real MCP connection failures (isolated)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-mcp-errors-')))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT)/.test(key)))
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
  const { connectToServer, clearServerCache } = await import('./client.js')
  test.each([
    {name:'transport closes during initialize', message:undefined, expected:'Connection closed'},
    {name:'server rejects initialize', message:'Fixture invalid parameters', expected:'Fixture invalid parameters'},
    {name:'server message contains an MCP-looking prefix', message:'MCP error -32000: server-owned text', expected:'MCP error -32000: server-owned text'},
  ])('$name preserves the official error body', async ({message,expected}) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(),'cc-mcp-connection-')))
    const file = join(root,'server.mjs')
    const config: import('./types.js').ScopedMcpServerConfig = {type:'stdio',command:process.execPath,args:[file],scope:'dynamic'}
    const name = 'owned-' + root.split('/').at(-1)
    writeFileSync(file,message === undefined ? 'process.exit(0)' : `
      let buffer = ''
      process.stdin.on('data',chunk => {
        buffer += chunk
        const end = buffer.indexOf('\\n')
        if (end < 0) return
        const request = JSON.parse(buffer.slice(0,end))
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:${JSON.stringify(message)}}})+'\\n',()=>process.exit(0))
      })
    `)
    try {
      // Official 2.1.292 native mcp_set_servers: remove only the SDK's outer prefix.
      const first = await connectToServer(name,config)
      expect(first.type).toBe('failed')
      expect(first.type === 'failed' && first.error).toBe(expected)
      expect(await connectToServer(name,config)).toBe(first)
    } finally { await clearServerCache(name,config);rmSync(root,{recursive:true,force:true}) }
  })
  test('ordinary errors keep text that happens to resemble an MCP wrapper', async () => {
    const { Client } = await import('@modelcontextprotocol/client')
    const message = 'MCP error -32000: application-owned text'
    const connect = spyOn(Client.prototype,'connect').mockRejectedValue(new Error(message))
    const config: import('./types.js').ScopedMcpServerConfig = {type:'stdio',command:process.execPath,args:[],scope:'dynamic'}
    try {
      const result = await connectToServer('ordinary-error',config)
      expect(result.type === 'failed' && result.error).toBe(message)
    } finally { connect.mockRestore();await clearServerCache('ordinary-error',config) }
  })

  test.each(['/no/such/owned-mcp-command', process.execPath])('missing stdio args are rejected before connecting %s', async command => {
    const { Client } = await import('@modelcontextprotocol/client')
    const connect = spyOn(Client.prototype,'connect').mockRejectedValue(new Error('transport must not start'))
    // The SDK control schema accepts omitted args; official 2.1.292 fails before spawning.
    const config = {type:'stdio',command,scope:'dynamic'} as import('./types.js').ScopedMcpServerConfig
    const name = 'missing-args-' + (command === process.execPath ? 'existing' : 'missing')
    try {
      const result = await connectToServer(name,config)
      expect(result.type === 'failed' && result.error).toBe('Spread syntax requires ...iterable not be null or undefined')
      expect(connect).not.toHaveBeenCalled()
      expect(await connectToServer(name,config)).toBe(result)
    } finally { connect.mockRestore();await clearServerCache(name,config) }
  })

}
