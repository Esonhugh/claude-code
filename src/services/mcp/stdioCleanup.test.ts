import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_MCP_STDIO_CLEANUP_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('stdio MCP cleanup terminates stubborn servers (isolated)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-mcp-stdio-cleanup-')))
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
  const { connectToServer, clearServerCache } = await import('./client.js')
  const alive = (pid: number) => { try { process.kill(pid,0); return true } catch { return false } }

  // Official 2.1.292 escalates SIGINT -> SIGTERM -> SIGKILL for `type==="stdio"||!type`.
  // Without that, an untyped server that ignores stdin EOF and SIGTERM outlives the
  // SDK close() window (2s + 2s) and is orphaned when the CLI exits first.
  test.each([
    {label:'type: "stdio"', type:'stdio' as const},
    {label:'type omitted', type:undefined},
  ])('$label server that ignores SIGINT/SIGTERM is killed promptly', async ({type}) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(),'cc-mcp-stdio-')))
    const file = join(root,'server.mjs')
    const pidFile = join(root,'pid')
    writeFileSync(file,`
      import { writeFileSync } from 'node:fs'
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
      process.on('SIGINT',()=>{})
      process.on('SIGTERM',()=>{})
      setInterval(()=>{},1000)
      let buffer = ''
      process.stdin.on('data',chunk => {
        buffer += chunk
        let end
        while ((end = buffer.indexOf('\\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0,end))
          buffer = buffer.slice(end + 1)
          if (message.method === 'initialize') {
            process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:message.params.protocolVersion,capabilities:{},serverInfo:{name:'stubborn',version:'1'}}})+'\\n')
          } else if (message.id !== undefined) {
            process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}})+'\\n')
          }
        }
      })
      process.stdin.on('end',()=>{})
    `)
    const config = {...(type ? {type} : {}),command:process.execPath,args:[file],scope:'dynamic'} as import('./types.js').ScopedMcpServerConfig
    const name = 'stubborn-' + root.split('/').at(-1)
    let pid: number | undefined
    try {
      const connection = await connectToServer(name,config)
      expect(connection.type).toBe('connected')
      if (connection.type !== 'connected') throw new Error('expected connected')
      pid = Number(readFileSync(pidFile,'utf8'))
      expect(alive(pid)).toBe(true)
      const cleanup = connection.cleanup()
      const deadline = Date.now() + 1500
      while (alive(pid) && Date.now() < deadline) await Bun.sleep(25)
      expect(alive(pid)).toBe(false)
      await cleanup
    } finally {
      if (pid && alive(pid)) process.kill(pid,'SIGKILL')
      await clearServerCache(name,config)
      rmSync(root,{recursive:true,force:true})
    }
  },10_000)
}
