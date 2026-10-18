import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_AGENT_MCP_SHARED_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('concurrent agents share an inline MCP server until the last one ends (isolated)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-agent-mcp-shared-')))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT)/.test(key)))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--timeout', '30000', import.meta.path], {
        cwd: root,
        env: { ...env, [childFlag]: '1', HOME: root, CLAUDE_CONFIG_DIR: root, TMPDIR: root,
          AGENT_MCP_SHARED_ROOT: root, DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const root = process.env.AGENT_MCP_SHARED_ROOT!
  const state = await import('../../bootstrap/state.js')
  state.setOriginalCwd(root)
  state.setProjectRoot(root)
  state.setCwdState(root)
  const { enableConfigs } = await import('../../utils/config.js')
  enableConfigs()
  const { initializeAgentMcpServersForTesting } = await import('./runAgent.js')
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

  test('the first agent to finish does not stop the server the other agent still uses', async () => {
    const server = join(root, 'server.mjs')
    const pids = join(root, 'pids')
    writeFileSync(pids, '')
    writeFileSync(server, `
      import { appendFileSync } from 'node:fs'
      appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n')
      let buffer = ''
      process.stdin.on('data', chunk => {
        buffer += chunk
        let end
        while ((end = buffer.indexOf('\\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          if (message.method === 'initialize')
            process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'shared',version:'1'}}})+'\\n')
          else if (message.method === 'tools/list')
            process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{tools:[{name:'echo',inputSchema:{type:'object'}}]}})+'\\n')
          else if (message.id !== undefined)
            process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}})+'\\n')
        }
      })
    `)
    const agent = {
      agentType: 'mcp-shared',
      whenToUse: 'probe',
      source: 'userSettings',
      getSystemPrompt: () => '',
      mcpServers: [{ 'shared-inline': { type: 'stdio', command: process.execPath, args: [server] } }],
    } as never
    const first = await initializeAgentMcpServersForTesting(agent, [])
    const second = await initializeAgentMcpServersForTesting(agent, [])
    const spawned = () => readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number)
    try {
      expect(first.tools.map(t => t.name)).toEqual(['mcp__shared-inline__echo'])
      expect(second.tools.map(t => t.name)).toEqual(['mcp__shared-inline__echo'])
      expect(spawned()).toHaveLength(1)
      const [pid] = spawned()

      await first.cleanup()
      expect(alive(pid!)).toBe(true)

      await second.cleanup()
      for (let i = 0; i < 100 && alive(pid!); i++) await new Promise(resolve => setTimeout(resolve, 50))
      expect(alive(pid!)).toBe(false)
      expect(spawned()).toHaveLength(1)
    } finally {
      for (const pid of spawned()) if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  })
}
