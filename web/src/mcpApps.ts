// MCP Apps (SEP-1865): an MCP tool names a `ui://` resource, an HTML page the
// chat renders under the tool call in a sandboxed frame.

export type AppTool = {
  serverName: string
  toolName: string
  resourceUri: string
  /** The tool is for the model too (visibility lists "model", or is not declared). */
  modelVisible: boolean
  readOnly: boolean
}

/** An `mcp_status` tool an app might call; only those with a `resourceUri` render an app. */
export type AppServerTool = Omit<AppTool, 'resourceUri'> & { resourceUri?: string; appVisible: boolean }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The CLI's `normalizeNameForMCP`, so `mcp__<server>__<tool>` can be matched to mcp_status. */
export function normalizeMcpName(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (name.startsWith('claude.ai ')) normalized = normalized.replace(/_+/g, '_').replace(/^_|_$/g, '')
  return normalized
}

function uiResourceUri(meta: Record<string, unknown>): string | undefined {
  const ui = isObj(meta.ui) ? meta.ui : undefined
  const uri = typeof ui?.resourceUri === 'string' ? ui.resourceUri : meta['ui/resourceUri']
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : undefined
}

function visibility(meta: Record<string, unknown>): unknown[] | undefined {
  const ui = isObj(meta.ui) ? meta.ui : undefined
  return Array.isArray(ui?.visibility) ? ui.visibility : undefined
}

/** Every tool of a connected server in an `mcp_status` reply. */
export function appTools(status: Record<string, unknown>): AppServerTool[] {
  const servers = Array.isArray(status.mcpServers) ? status.mcpServers : []
  return servers.filter(isObj).flatMap(server => {
    const serverName = typeof server.name === 'string' ? server.name : undefined
    const tools = Array.isArray(server.tools) ? server.tools : []
    if (!serverName || server.status !== 'connected') return []
    return tools.filter(isObj).flatMap(tool => {
      const meta = isObj(tool._meta) ? tool._meta : {}
      if (typeof tool.name !== 'string') return []
      const seen = visibility(meta)
      return [
        {
          serverName,
          toolName: tool.name,
          resourceUri: uiResourceUri(meta),
          modelVisible: !seen || seen.includes('model'),
          appVisible: !seen || seen.includes('app'),
          readOnly: isObj(tool.annotations) && tool.annotations.readOnly === true,
        },
      ]
    })
  })
}

/** The app tool a chat tool call (`mcp__<server>__<tool>`) is, if any; none when two tools share that name. */
export function findAppTool(tools: AppServerTool[], blockName: string): AppTool | undefined {
  const named = tools.filter(t => `mcp__${normalizeMcpName(t.serverName)}__${normalizeMcpName(t.toolName)}` === blockName)
  const tool = named.length === 1 ? named[0] : undefined
  return tool?.resourceUri ? { ...tool, resourceUri: tool.resourceUri } : undefined
}

// A CSP source an app's `_meta.ui.csp` may name: an http(s)/ws(s) origin, optionally `*.`-wildcarded.
const SOURCE = /^(https?|wss?):\/\/(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/i

function sources(value: unknown): string {
  const list = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && SOURCE.test(v)) : []
  return list.join(' ')
}

/**
 * The CSP an app runs under, from its resource's `_meta.ui.csp`
 * (`connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`).
 * With none declared, the app reaches no network and loads only inline code
 * and data: URLs. Anything that is not a plain origin is dropped.
 */
export function appCsp(meta: unknown): string {
  const csp = isObj(meta) && isObj(meta.ui) && isObj(meta.ui.csp) ? meta.ui.csp : {}
  const resources = sources(csp.resourceDomains)
  const connect = sources(csp.connectDomains)
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources}`,
    `style-src 'unsafe-inline' ${resources}`,
    `img-src data: blob: ${resources}`,
    `font-src data: ${resources}`,
    `media-src data: blob: ${resources}`,
    `connect-src ${connect || "'none'"}`,
    `frame-src ${sources(csp.frameDomains) || "'none'"}`,
    `base-uri ${sources(csp.baseUriDomains) || "'none'"}`,
  ]
    .map(d => d.trim())
    .join('; ')
}

/** The app's HTML with its CSP as the first thing parsed. */
export function withCsp(html: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}">`
  return `<!doctype html>${meta}${html.replace(/^\s*<!doctype[^>]*>/i, '')}`
}

/** The HTML of an `mcp_read_resource` reply. */
export function resourceHtml(response: Record<string, unknown>): { html: string; meta?: Record<string, unknown> } | undefined {
  const item = (Array.isArray(response.contents) ? response.contents : []).find(isObj)
  if (!item) return undefined
  const meta = isObj(item._meta) ? item._meta : undefined
  if (typeof item.text === 'string') return { html: item.text, meta }
  if (typeof item.blob === 'string') {
    try {
      const bytes = Uint8Array.from(atob(item.blob), c => c.charCodeAt(0))
      return { html: new TextDecoder().decode(bytes), meta }
    } catch {
      return undefined
    }
  }
  return undefined
}

/** A link an app may ask the page to open: http(s) only. */
export function openableLink(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

/**
 * An `mcp_call` reply as the CallToolResult an app expects. The CLI replies with
 * the model-facing content: a string, or Anthropic content blocks.
 */
export function callToolResult(response: Record<string, unknown>): Record<string, unknown> {
  const { content } = response
  const blocks =
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : (Array.isArray(content) ? content : []).filter(isObj).map(block =>
          block.type === 'image' && isObj(block.source)
            ? { type: 'image', data: block.source.data, mimeType: block.source.media_type }
            : block,
        )
  return { ...response, content: blocks }
}
