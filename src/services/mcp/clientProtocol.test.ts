import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const childFlag = 'CLAUDE_CODE_MCP_CLIENT_PROTOCOL_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('MCP client protocol behavior (isolated)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-mcp-protocol-')))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SHELL_PREFIX|HTTPS?_PROXY$|https?_proxy$|MCP_TIMEOUT$)/.test(key)))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        env: {...env, [childFlag]:'1', HOME:root, CLAUDE_CONFIG_DIR:root, NO_PROXY:'127.0.0.1,localhost',
          ANTHROPIC_API_KEY:'test-only-placeholder', DISABLE_TELEMETRY:'1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},
        stdout:'pipe', stderr:'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
      if (code !== 0) throw new Error(stdout + '\n' + stderr)
      console.log((stdout + stderr).match(/\d+ pass[\s\S]*?Ran [^\n]+/)?.[0])
    } finally { rmSync(root,{recursive:true,force:true}) }
  },60_000)
} else {
  ;(globalThis as typeof globalThis & {MACRO:{VERSION:string}}).MACRO = {VERSION:'test'}
  const client = await import('./client.js')
  const { connectToServer, clearServerCache, fetchToolsForClient, transformMCPResult, callMCPToolWithUrlElicitationRetry } = client
  const { getOriginalCwd } = await import('../../bootstrap/state.js')
  const { ListMcpResourcesTool } = await import('../../tools/ListMcpResourcesTool/ListMcpResourcesTool.js')
  const { ReadMcpResourceTool } = await import('../../tools/ReadMcpResourceTool/ReadMcpResourceTool.js')
  const { ReadMcpResourceDirTool } = await import('../../tools/ReadMcpResourceDirTool/ReadMcpResourceDirTool.js')
  type Connection = import('./types.js').MCPServerConnection
  type Config = import('./types.js').ScopedMcpServerConfig

  const waitFor = async (check: () => boolean, ms = 5000) => {
    const start = Date.now()
    while (!check()) {
      if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
      await Bun.sleep(20)
    }
  }

  // Raw JSON-RPC stdio fixture. Every inbound message is appended to `log`.
  // mode "java" mimics Java MCP SDK <= 0.17.0, whose ClientCapabilities.Elicitation
  // class has no fields and rejects {form, url} at initialize.
  async function withStdioServer(mode: 'capture' | 'java', run: (connection: Connection, messages: () => Record<string, any>[], root: string) => Promise<void>) {
    const root = realpathSync(mkdtempSync(join(tmpdir(),'cc-mcp-protocol-stdio-')))
    const file = join(root,'server.mjs')
    const log = join(root,'log.jsonl')
    writeFileSync(log,'')
    writeFileSync(file,`
      import { appendFileSync } from 'node:fs'
      const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
      let pendingToolCall
      let buffer = ''
      process.stdin.on('data', chunk => {
        buffer += chunk
        let end
        while ((end = buffer.indexOf('\\n')) >= 0) {
          const msg = JSON.parse(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          appendFileSync(${JSON.stringify(log)}, JSON.stringify(msg) + '\\n')
          if (msg.method === 'initialize') {
            const elicitation = msg.params.capabilities.elicitation ?? {}
            if (${JSON.stringify(mode)} === 'java' && ('form' in elicitation || 'url' in elicitation)) {
              send({jsonrpc:'2.0', id:msg.id, error:{code:-32603, message:'Unrecognized field "url" (class io.modelcontextprotocol.spec.McpSchema$ClientCapabilities$Elicitation), not marked as ignorable (0 known properties: ])'}})
              continue
            }
            send({jsonrpc:'2.0', id:msg.id, result:{protocolVersion:msg.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'fixture', version:'1'}}})
          } else if (msg.method === 'notifications/initialized') {
            send({jsonrpc:'2.0', id:'roots-1', method:'roots/list'})
          } else if (msg.method === 'notifications/roots/list_changed') {
            send({jsonrpc:'2.0', id:'roots-2', method:'roots/list'})
          } else if (msg.method === 'tools/list') {
            send({jsonrpc:'2.0', id:msg.id, result:{tools:[{name:'fail', inputSchema:{type:'object'}}, {name:'elicit', inputSchema:{type:'object'}}]}})
          } else if (msg.method === 'tools/call' && msg.params.name === 'elicit') {
            pendingToolCall = msg.id
            send({jsonrpc:'2.0', id:'elicit-1', method:'elicitation/create', params:{mode:'url', message:'Sign in', url:'https://owned.invalid/auth', elicitationId:'e1'}})
          } else if (msg.id === 'elicit-1') {
            send({jsonrpc:'2.0', id:pendingToolCall, result:{content:[{type:'text', text:JSON.stringify(msg)}]}})
          } else if (msg.method === 'tools/call') {
            send({jsonrpc:'2.0', id:msg.id, result:{isError:true, content:[
              {type:'text', text:'first'},
              {type:'image', data:'AAAA', mimeType:'image/png'},
              {type:'text', text:'second'},
              {type:'resource_link', name:'log', uri:'owned://log', description:'full log'},
            ]}})
          } else if (msg.method && msg.id !== undefined) {
            send({jsonrpc:'2.0', id:msg.id, error:{code:-32601, message:'Method not found'}})
          }
        }
      })
    `)
    const config: Config = {type:'stdio',command:process.execPath,args:[file],scope:'dynamic'}
    const name = 'protocol-' + root.split('/').at(-1)
    const messages = () => readFileSync(log,'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    try {
      const connection = await connectToServer(name,config)
      await run(connection, messages, root)
    } finally {
      await clearServerCache(name,config)
      rmSync(root,{recursive:true,force:true})
    }
  }

  // Official 2.1.292 (Un): non-text content blocks are kept and the structured
  // content is appended as a JSON text block.
  test('structuredContent results keep non-text content blocks and append the JSON', async () => {
    const structuredContent = {status:'ok', count:2}
    const withResource = await transformMCPResult({
      structuredContent,
      content:[
        {type:'text', text:JSON.stringify(structuredContent)},
        {type:'resource', resource:{uri:'owned://doc', text:'body'}},
      ],
    },'tool','srv')
    expect(withResource.type).toBe('contentArray')
    expect(withResource.content).toEqual([
      {type:'text', text:'[Resource from srv at owned://doc] body'},
      {type:'text', text:JSON.stringify(structuredContent)},
    ])

    const textOnly = await transformMCPResult({structuredContent, content:[{type:'text', text:'ignored'}]},'tool','srv')
    expect(textOnly).toEqual({content:JSON.stringify(structuredContent), type:'structuredContent', schema:'{status: string, count: number}'})
  })

  // Official 2.1.292 (Ao): every block with text plus resource_link blocks, joined by newlines.
  test('isError results report every text block and resource links', async () => {
    await withStdioServer('capture', async connection => {
      expect(connection.type).toBe('connected')
      if (connection.type !== 'connected') return
      const error = await callMCPToolWithUrlElicitationRetry({
        client:connection, clientConnection:connection, tool:'fail', args:{},
        signal:new AbortController().signal, setAppState:() => {},
      }).catch(e => e)
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toBe('first\nsecond\n[Resource link: log] owned://log (full log)')
    })
  },15_000)

  test('resource helper tools are present once while a connected server supports resources', () => {
    const resourceTools = [ListMcpResourcesTool, ReadMcpResourceTool, ReadMcpResourceDirTool]
    const serverTool = {name:'mcp__docs__search'} as import('../../Tool.js').Tool
    const config: Config = {type:'stdio',command:'unused',args:[],scope:'dynamic'}
    const withResources = {name:'docs', type:'connected', capabilities:{resources:{}}, config} as unknown as Connection
    const withoutResources = {...withResources, capabilities:{}} as Connection
    const failed = {name:'docs', type:'failed', config} as Connection

    // Two reconnects each appended the helpers; they collapse to one copy.
    const duplicated = [serverTool, ...resourceTools, ...resourceTools]
    expect(client.syncMcpResourceTools([withResources], duplicated).map(t => t.name)).toEqual([serverTool.name, ...resourceTools.map(t => t.name)])
    expect(client.syncMcpResourceTools([withoutResources], duplicated)).toEqual([serverTool])
    expect(client.syncMcpResourceTools([failed], [...resourceTools])).toEqual([])
    expect(client.syncMcpResourceTools([withoutResources], [serverTool]).map(t => t.name)).toEqual([serverTool.name])
    expect(client.syncMcpResourceTools([failed, withResources], [serverTool]).map(t => t.name)).toEqual([serverTool.name, ...resourceTools.map(t => t.name)])
  })

  // Official 2.1.292: capabilities {roots:{listChanged:true}, elicitation:{form:{},url:{}}};
  // roots/list returns the cwd plus additional working directories, and
  // notifyMcpRootsListChanged sends notifications/roots/list_changed.
  test('declares roots.listChanged and form+url elicitation, and notifies roots changes', async () => {
    await withStdioServer('capture', async (connection, messages, root) => {
      expect(connection.type).toBe('connected')
      if (connection.type !== 'connected') return
      const init = messages().find(m => m.method === 'initialize')
      expect(init?.params.capabilities).toEqual({roots:{listChanged:true}, elicitation:{form:{}, url:{}}})

      await waitFor(() => messages().some(m => m.id === 'roots-1'))
      expect(messages().find(m => m.id === 'roots-1')?.result).toEqual({roots:[{uri:pathToFileURL(getOriginalCwd()).href}]})

      // /add-dir and /permissions update the permission context; the AppState
      // change hook publishes the directories to connected servers.
      const extra = join(root,'extra dir')
      mkdirSync(extra)
      const { getDefaultAppState } = await import('../../state/AppStateStore.js')
      const { onChangeAppState } = await import('../../state/onChangeAppState.js')
      const oldState = getDefaultAppState()
      const additionalWorkingDirectories = new Map([
        [extra, {path:extra, source:'session' as const}],
        [getOriginalCwd(), {path:getOriginalCwd(), source:'session' as const}],
      ])
      onChangeAppState({oldState, newState:{...oldState, toolPermissionContext:{...oldState.toolPermissionContext, additionalWorkingDirectories}}})
      await waitFor(() => messages().some(m => m.id === 'roots-2'))
      expect(messages().filter(m => m.method === 'notifications/roots/list_changed')).toHaveLength(1)
      expect(messages().find(m => m.id === 'roots-2')?.result).toEqual({roots:[
        {uri:pathToFileURL(getOriginalCwd()).href},
        {uri:pathToFileURL(extra).href},
      ]})
      client.notifyMcpRootsListChanged([])
    })
  },15_000)

  test('URL-mode elicitation requests reach the client handler', async () => {
    await withStdioServer('capture', async connection => {
      if (connection.type !== 'connected') throw new Error(`not connected: ${JSON.stringify(connection)}`)
      const result = await connection.client.callTool({name:'elicit', arguments:{}})
      const reply = JSON.parse((result.content as Array<{text:string}>)[0]!.text)
      expect(reply.error).toBeUndefined()
      expect(reply.result).toEqual({action:'cancel'})
    })
  },15_000)

  // Official 2.1.292: "server rejected elicitation form and url at initialize (Java
  // MCP SDK 0.17.0 or older); reconnecting once without elicitation form and url".
  test('a server rejecting elicitation form/url at initialize is reconnected once with bare elicitation', async () => {
    await withStdioServer('java', async (connection, messages) => {
      expect(connection.type).toBe('connected')
      const inits = messages().filter(m => m.method === 'initialize')
      expect(inits.map(m => m.params.capabilities.elicitation)).toEqual([{form:{}, url:{}}, {}])
    })
  },15_000)

  // Official 2.1.292: an http server whose initialize POST is rejected with a
  // non-JSON-RPC 4xx (not 401/403/429) is retried over legacy HTTP+SSE.
  async function withLegacySseServer(post: {status:number, body:string, type:string}, run: (config: Config, name: string, requests: string[]) => Promise<void>) {
    const { createServer } = await import('node:http')
    const requests: string[] = []
    // Minimal legacy HTTP+SSE server (2024-11-05 transport): the GET stream
    // announces the POST endpoint and carries every JSON-RPC response.
    const streams = new Map<string, import('node:http').ServerResponse>()
    const answer = (msg: {id?: number, method: string, params?: {protocolVersion?: string}}) => {
      if (msg.id === undefined) return undefined
      if (msg.method === 'initialize') return {protocolVersion: msg.params?.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: 'legacy', version: '1'}}
      if (msg.method === 'tools/list') return {tools: [{name: 'legacy_tool', inputSchema: {type: 'object'}}]}
      return {}
    }
    const http = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      requests.push(`${req.method} ${url.pathname}`)
      if (url.pathname === '/mcp' && req.method === 'POST') {
        res.writeHead(post.status, {'content-type':post.type})
        res.end(post.body)
      } else if (url.pathname === '/mcp' && req.method === 'GET') {
        const sessionId = String(streams.size + 1)
        streams.set(sessionId, res)
        res.writeHead(200, {'content-type':'text/event-stream', 'cache-control':'no-cache'})
        res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`)
      } else if (url.pathname === '/messages' && req.method === 'POST') {
        const stream = streams.get(url.searchParams.get('sessionId') ?? '')
        let body = ''
        for await (const chunk of req) body += chunk
        const msg = JSON.parse(body)
        res.writeHead(202).end('Accepted')
        const result = answer(msg)
        if (result) stream?.write(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0', id: msg.id, result})}\n\n`)
      } else {
        res.writeHead(404).end()
      }
    })
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const port = (http.address() as import('node:net').AddressInfo).port
    const config: Config = {type:'http', url:`http://127.0.0.1:${port}/mcp`, scope:'dynamic'}
    const name = `legacy-sse-${port}`
    try {
      await run(config, name, requests)
    } finally {
      await clearServerCache(name, config)
      for (const stream of streams.values()) stream.end()
      http.closeAllConnections?.()
      await new Promise(resolve => http.close(resolve))
    }
  }

  test('http initialize POST rejected with 405 falls back to legacy HTTP+SSE', async () => {
    await withLegacySseServer({status:405, body:'Method Not Allowed', type:'text/plain'}, async (config, name, requests) => {
      const connection = await connectToServer(name, config)
      if (connection.type !== 'connected') throw new Error(`not connected: ${JSON.stringify(connection)}`)
      expect(connection.config).toEqual(config)
      const tools = await fetchToolsForClient(connection)
      expect(tools.map(t => t.mcpInfo?.toolName)).toEqual(['legacy_tool'])
      expect(requests).toContain('GET /mcp')
    })
  },15_000)

  test('http initialize rejected with a JSON-RPC error body does not fall back', async () => {
    const body = JSON.stringify({jsonrpc:'2.0', id:null, error:{code:-32600, message:'Bad Request: owned'}})
    await withLegacySseServer({status:400, body, type:'application/json'}, async (config, name, requests) => {
      const connection = await connectToServer(name, config)
      expect(connection.type).toBe('failed')
      expect(requests).not.toContain('GET /mcp')
    })
  },15_000)

  // Official 2.1.303: stdio, http and claude.ai proxy connections negotiate MCP
  // 2026-07-28 (server/discover, falling back to initialize);
  // MCP_PROTOCOL_NEGOTIATION=legacy opts out, =auto forces it.
  test('MCP_PROTOCOL_NEGOTIATION selects the version negotiation per transport', () => {
    const { getMcpVersionNegotiation } = client
    const saved = {mode:process.env.MCP_PROTOCOL_NEGOTIATION, timeout:process.env.MCP_TIMEOUT}
    try {
      delete process.env.MCP_PROTOCOL_NEGOTIATION
      delete process.env.MCP_TIMEOUT
      expect(getMcpVersionNegotiation('stdio')).toEqual({mode:'auto', probe:{timeoutMs:3000}})
      expect(getMcpVersionNegotiation('http')).toEqual({mode:'auto', probe:{timeoutMs:5000}})
      expect(getMcpVersionNegotiation('claudeai-proxy')).toEqual({mode:'auto', probe:{timeoutMs:5000}})
      expect(getMcpVersionNegotiation('legacy-only')).toEqual({mode:'legacy'})
      expect(getMcpVersionNegotiation('in-process')).toEqual({mode:'legacy'})
      process.env.MCP_TIMEOUT = '6000'
      expect(getMcpVersionNegotiation('http')).toEqual({mode:'auto', probe:{timeoutMs:2000}})
      process.env.MCP_PROTOCOL_NEGOTIATION = 'legacy'
      expect(getMcpVersionNegotiation('stdio')).toEqual({mode:'legacy'})
      process.env.MCP_PROTOCOL_NEGOTIATION = 'auto'
      expect(getMcpVersionNegotiation('legacy-only')).toEqual({mode:'legacy'})
      process.env.MCP_PROTOCOL_NEGOTIATION = 'bogus'
      expect(getMcpVersionNegotiation('stdio')).toEqual({mode:'auto', probe:{timeoutMs:2000}})
    } finally {
      for (const [key, value] of [['MCP_PROTOCOL_NEGOTIATION', saved.mode], ['MCP_TIMEOUT', saved.timeout]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  const serverEntry = Bun.resolveSync('@modelcontextprotocol/server', import.meta.dir)
  const serverStdioEntry = Bun.resolveSync('@modelcontextprotocol/server/stdio', import.meta.dir)

  async function connectedProtocol(name: string, config: Config, mode?: 'legacy') {
    if (mode) process.env.MCP_PROTOCOL_NEGOTIATION = mode
    try {
      const connection = await connectToServer(name, config)
      if (connection.type !== 'connected') throw new Error(`not connected: ${JSON.stringify(connection)}`)
      const result = await connection.client.callTool({name:'echo', arguments:{}})
      expect(result.content).toEqual([{type:'text', text:'ok'}])
      return connection.client.getNegotiatedProtocolVersion()
    } finally {
      delete process.env.MCP_PROTOCOL_NEGOTIATION
      await clearServerCache(name, config)
    }
  }

  test('stdio servers negotiate 2026-07-28 when they serve it and fall back otherwise', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(),'cc-mcp-negotiation-stdio-')))
    const server = (era: 'modern' | 'legacy') => {
      const file = join(root, `${era}.mjs`)
      writeFileSync(file, `
        import { McpServer } from ${JSON.stringify(serverEntry)}
        import { serveStdio, StdioServerTransport } from ${JSON.stringify(serverStdioEntry)}
        const create = () => {
          const server = new McpServer({name:'${era}', version:'1'}, {capabilities:{tools:{}}})
          server.registerTool('echo', {description:'echo'}, async () => ({content:[{type:'text', text:'ok'}]}))
          return server
        }
        if (${JSON.stringify(era)} === 'modern') serveStdio(create)
        else await create().connect(new StdioServerTransport())
      `)
      return {type:'stdio', command:process.execPath, args:[file], scope:'dynamic'} as Config
    }
    try {
      expect(await connectedProtocol('negotiation-modern-stdio', server('modern'))).toBe('2026-07-28')
      expect(await connectedProtocol('negotiation-legacy-stdio', server('legacy'))).toBe('2025-11-25')
      expect(await connectedProtocol('negotiation-optout-stdio', server('modern'), 'legacy')).toBe('2025-11-25')
    } finally {
      rmSync(root,{recursive:true,force:true})
    }
  },30_000)

  test('http servers negotiate 2026-07-28 when they serve it and fall back otherwise', async () => {
    const { McpServer, createMcpHandler, WebStandardStreamableHTTPServerTransport } = await import('@modelcontextprotocol/server')
    const create = () => {
      const server = new McpServer({name:'http', version:'1'}, {capabilities:{tools:{}}})
      server.registerTool('echo', {description:'echo'}, async () => ({content:[{type:'text' as const, text:'ok'}]}))
      return server
    }
    const modern = createMcpHandler(create)
    const sessions = new Map<string, InstanceType<typeof WebStandardStreamableHTTPServerTransport>>()
    const http = Bun.serve({port:0, hostname:'127.0.0.1', async fetch(req) {
      if (new URL(req.url).pathname === '/modern') return modern.fetch(req)
      const existing = sessions.get(req.headers.get('mcp-session-id') ?? '')
      if (existing) return existing.handleRequest(req)
      const transport: InstanceType<typeof WebStandardStreamableHTTPServerTransport> = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: id => { sessions.set(id, transport) },
      })
      await create().connect(transport)
      return transport.handleRequest(req)
    }})
    const config = (path: string) => ({type:'http', url:`http://127.0.0.1:${http.port}/${path}`, scope:'dynamic'}) as Config
    try {
      expect(await connectedProtocol('negotiation-modern-http', config('modern'))).toBe('2026-07-28')
      expect(await connectedProtocol('negotiation-legacy-http', config('legacy'))).toBe('2025-11-25')
      expect(await connectedProtocol('negotiation-optout-http', config('modern'), 'legacy')).toBe('2025-11-25')
    } finally {
      await modern.close()
      http.stop(true)
    }
  },30_000)
}
