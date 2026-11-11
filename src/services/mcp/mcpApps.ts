// MCP Apps (SEP-1865): a tool names a `ui://` resource that a host renders.
// Mirrors official 2.1.322: the CLI only validates and forwards; a host
// (claude web, an SDK client) renders the resource.
import { isEnvTruthy } from '../../utils/envUtils.js'

export const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui'
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'
const UI_SCHEME = 'ui://'
/** The deprecated flat key some servers still send instead of `ui.resourceUri`. */
const LEGACY_RESOURCE_URI_KEY = 'ui/resourceUri'
const MAX_UI_META_CHARS = 4096
const AUDIENCES = ['model', 'app'] as const

export type McpToolUiMeta = {
  ui?: Record<string, unknown>
  [LEGACY_RESOURCE_URI_KEY]?: string
}

/** Set by a host that renders `ui://` resources; makes the CLI offer the extension. */
export function isMcpAppsHost(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_MCP_APPS_HOST)
}

export function mcpAppsClientExtensions():
  | { [MCP_APPS_EXTENSION]: { mimeTypes: string[] } }
  | undefined {
  return isMcpAppsHost()
    ? { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } }
    : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUiUri(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(UI_SCHEME)
}

/**
 * The audiences `_meta.ui.visibility` lists. undefined when the tool declares
 * none; [] when `ui` or `visibility` has the wrong shape (neither audience).
 */
function declaredVisibility(meta: Record<string, unknown> | undefined): string[] | undefined {
  const ui = meta?.ui
  if (ui === undefined || ui === null) return undefined
  if (!isObject(ui)) return []
  const visibility = Object.hasOwn(ui, 'visibility') ? ui.visibility : undefined
  if (visibility === undefined || visibility === null) return undefined
  return Array.isArray(visibility) ? AUDIENCES.filter(a => visibility.includes(a)) : []
}

/** A tool whose `_meta.ui.visibility` leaves out "model" is for the app only. */
export function isToolHiddenFromModel(meta: Record<string, unknown> | undefined): boolean {
  return declaredVisibility(meta)?.includes('model') === false
}

function validUi(ui: unknown): Record<string, unknown> | undefined {
  if (!isObject(ui)) return undefined
  if (ui.resourceUri !== undefined && !isUiUri(ui.resourceUri)) return undefined
  if (
    ui.visibility !== undefined &&
    !(Array.isArray(ui.visibility) && ui.visibility.every(v => (AUDIENCES as readonly unknown[]).includes(v)))
  ) {
    return undefined
  }
  let size: number
  try {
    size = JSON.stringify(ui).length
  } catch {
    return undefined
  }
  return size <= MAX_UI_META_CHARS ? ui : undefined
}

/**
 * The MCP Apps members of a tool's `_meta`, validated, for hosts (mcp_status).
 * Every other `_meta` key is left out. A `ui` that fails validation still
 * passes on its `visibility`, so a host knows who the tool is for.
 */
export function toolUiMeta(meta: Record<string, unknown> | undefined): McpToolUiMeta | undefined {
  if (meta?.ui === undefined && meta?.[LEGACY_RESOURCE_URI_KEY] === undefined) return undefined
  const ui = validUi(meta.ui)
  const legacy = meta[LEGACY_RESOURCE_URI_KEY]
  const visibility = ui ? undefined : declaredVisibility(meta)
  const result: McpToolUiMeta = {
    ...(ui ? { ui } : visibility && { ui: { visibility } }),
    ...(isUiUri(legacy) &&
      legacy.length <= MAX_UI_META_CHARS && { [LEGACY_RESOURCE_URI_KEY]: legacy }),
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/** A `ui://` resource or an MCP App HTML page: for a host to render, not for the model's list. */
export function isMcpAppResource({ uri, mimeType }: { uri: string; mimeType?: string }): boolean {
  if (uri.slice(0, UI_SCHEME.length).toLowerCase() === UI_SCHEME) return true
  if (!mimeType || mimeType.length > 1024) return false
  const [type, ...params] = mimeType.split(';')
  if (type?.trim().toLowerCase() !== 'text/html') return false
  return params.some(param => {
    const eq = param.indexOf('=')
    if (eq === -1) return false
    const name = param.slice(0, eq).trim().toLowerCase()
    const value = param.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1').toLowerCase()
    return name === 'profile' && value === 'mcp-app'
  })
}
