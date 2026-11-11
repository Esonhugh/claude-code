import { useEffect, useRef, useState } from 'react'
import { type AppServerTool, type AppTool, appCsp, appTools, findAppTool, normalizeMcpName, openableLink, resourceHtml, withCsp } from '../mcpApps'
import type { Block } from '../protocol'
import type { Control } from './extShared'
import type { T } from './ui'

type ToolBlock = Extract<Block, { kind: 'tool' }>
type Rpc = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> }

const FRAME_PATH = '/mcp-app-frame'
const PROTOCOL_VERSION = '2026-01-26'

// One mcp_status per session (control function); asked again when a tool is not in it.
const statusCache = new WeakMap<Control, Promise<AppServerTool[]>>()

async function lookupAppTool(control: Control, name: string): Promise<AppTool | undefined> {
  const load = () => {
    const pending = control({ subtype: 'mcp_status' }).then(appTools)
    statusCache.set(control, pending)
    return pending
  }
  const cached = statusCache.get(control)
  const found = findAppTool(await (cached ?? load()).catch(() => []), name)
  if (found || !cached) return found
  return findAppTool(await load().catch(() => []), name)
}

function parsedArguments(input: string): Record<string, unknown> {
  try {
    const value = JSON.parse(input) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function toolResult(block: ToolBlock): Record<string, unknown> {
  return {
    content: block.mcp?.content ?? [{ type: 'text', text: block.result ?? '' }],
    ...(block.mcp?.structuredContent !== undefined && { structuredContent: block.mcp.structuredContent }),
    ...(block.mcp?._meta && { _meta: block.mcp._meta }),
    ...(block.isError && { isError: true }),
  }
}

/** A tool call's MCP App, under its tool card, when the tool names a `ui://` resource. */
export function McpApp({ block, control, t }: { block: ToolBlock; control?: Control; t: T }) {
  const [app, setApp] = useState<{ tool: AppTool; html: string }>()
  const [height, setHeight] = useState(160)
  const frame = useRef<HTMLIFrameElement>(null)
  const latest = useRef(block)
  latest.current = block
  const initialized = useRef(false)
  const sentResult = useRef(false)

  useEffect(() => {
    if (!control || !block.name.startsWith('mcp__')) return
    let live = true
    void (async () => {
      const tool = await lookupAppTool(control, block.name)
      if (!tool || !live) return
      const response = await control({ subtype: 'mcp_read_resource', serverName: tool.serverName, uri: tool.resourceUri }).catch(() => undefined)
      const resource = response && resourceHtml(response)
      if (resource && live) setApp({ tool, html: withCsp(resource.html, appCsp(resource.meta)) })
    })()
    return () => {
      live = false
    }
  }, [control, block.name])

  const post = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ jsonrpc: '2.0', ...message }, '*')

  const sendResult = () => {
    const current = latest.current
    if (!initialized.current || sentResult.current || current.result === undefined) return
    sentResult.current = true
    post({ method: 'ui/notifications/tool-result', params: toolResult(current) })
  }

  useEffect(sendResult, [block.result, block.mcp])

  useEffect(() => {
    if (!app || !control) return
    const { tool } = app
    const reply = (id: Rpc['id'], result: unknown) => post({ id, result })
    const fail = (id: Rpc['id'], message: string) => post({ id, error: { code: -32000, message } })

    const callTool = async (id: Rpc['id'], params: Record<string, unknown>) => {
      const name = typeof params.name === 'string' ? params.name : ''
      const status = await (statusCache.get(control) ?? Promise.resolve([] as AppServerTool[])).catch(() => [])
      const target = status.find(s => s.serverName === tool.serverName && s.toolName === name)
      // An app calls only its own server's tools. One for the app alone, or read-only, runs;
      // any other is one the model could call too, so it needs the user's yes.
      if (target?.appVisible === false) return fail(id, `Tool not available to apps: ${name}`)
      const ok =
        (target && (!target.modelVisible || target.readOnly)) ||
        window.confirm(t('mcpAppCallConfirm', { server: tool.serverName, tool: name }))
      if (!ok) return fail(id, `Tool call refused: ${name}`)
      try {
        const args = typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}
        const fullName = `mcp__${normalizeMcpName(tool.serverName)}__${normalizeMcpName(name)}`
        reply(id, await control({ subtype: 'mcp_call', tool: fullName, arguments: args }))
      } catch (error) {
        fail(id, error instanceof Error ? error.message : String(error))
      }
    }

    const onMessage = async (event: MessageEvent) => {
      const win = frame.current?.contentWindow
      if (!win || event.source !== win) return
      const data = event.data as Rpc & { type?: string }
      if (data?.type === 'claude-mcp-app-ready') {
        initialized.current = false
        sentResult.current = false
        win.postMessage({ type: 'claude-mcp-app', html: app.html }, '*')
        return
      }
      if (data?.jsonrpc !== '2.0' || typeof data.method !== 'string') return
      const params = data.params ?? {}
      switch (data.method) {
        case 'ui/initialize': {
          const dark = document.documentElement.dataset.theme
            ? document.documentElement.dataset.theme === 'dark'
            : window.matchMedia('(prefers-color-scheme: dark)').matches
          return reply(data.id, {
            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
            hostInfo: { name: 'claude-web', version: '1' },
            hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {} },
            hostContext: {
              theme: dark ? 'dark' : 'light',
              displayMode: 'inline',
              availableDisplayModes: ['inline'],
              locale: navigator.language,
              toolInfo: { id: latest.current.id, tool: { name: tool.toolName } },
            },
          })
        }
        case 'ui/notifications/initialized':
          initialized.current = true
          post({ method: 'ui/notifications/tool-input', params: { arguments: parsedArguments(latest.current.input) } })
          return sendResult()
        case 'ui/notifications/size-changed':
          if (typeof params.height === 'number') setHeight(Math.min(Math.max(Math.ceil(params.height), 40), 2000))
          return
        case 'ui/open-link': {
          const url = openableLink(params.url)
          if (!url) return fail(data.id, 'Only http(s) links open')
          window.open(url, '_blank', 'noopener,noreferrer')
          return reply(data.id, {})
        }
        case 'ui/request-display-mode':
          return reply(data.id, { mode: 'inline' })
        case 'tools/call':
          return callTool(data.id, params)
        case 'resources/read': {
          const uri = typeof params.uri === 'string' ? params.uri : ''
          if (!uri.startsWith('ui://')) return fail(data.id, 'Only ui:// resources can be read')
          try {
            return reply(data.id, await control({ subtype: 'mcp_read_resource', serverName: tool.serverName, uri }))
          } catch (error) {
            return fail(data.id, error instanceof Error ? error.message : String(error))
          }
        }
        case 'ping':
          return reply(data.id, {})
        default:
          if (data.id !== undefined) post({ id: data.id, error: { code: -32601, message: `Method not found: ${data.method}` } })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [app, control])

  if (!app) return null
  return (
    <iframe
      ref={frame}
      className="mcp-app"
      title={t('mcpAppTitle', { server: app.tool.serverName })}
      src={FRAME_PATH}
      sandbox="allow-scripts allow-forms"
      style={{ height }}
    />
  )
}
