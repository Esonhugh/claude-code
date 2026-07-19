import type { Tool } from '../../Tool.js'
import type { ConfigScope, MCPServerConnection } from '../../services/mcp/types.js'
import type {
  McpClaudeAIProxyServerConfig,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from '../../services/mcp/types.js'

export interface StdioServerInfo {
  name: string
  displayName?: string
  client: MCPServerConnection
  transport: 'stdio'
  command?: string
  args?: string[]
  type?: 'stdio'
  config?: McpStdioServerConfig
  env?: Record<string, string>
  scope: ConfigScope
  pluginSource?: string
  [key: string]: unknown
}

export interface SSEServerInfo {
  name: string
  displayName?: string
  client: MCPServerConnection
  transport?: 'sse'
  url?: string
  type?: 'sse'
  config?: McpSSEServerConfig
  scope: ConfigScope
  isAuthenticated?: boolean
  [key: string]: unknown
}

export interface HTTPServerInfo {
  name: string
  displayName?: string
  client: MCPServerConnection
  transport?: 'http'
  url?: string
  type?: 'http'
  config?: McpHTTPServerConfig
  scope: ConfigScope
  isAuthenticated?: boolean
  [key: string]: unknown
}

export interface ClaudeAIServerInfo {
  type?: 'claude_ai' | 'claudeai-proxy'
  transport?: 'claudeai-proxy'
  name: string
  displayName?: string
  client: MCPServerConnection
  config?: McpClaudeAIProxyServerConfig
  scope: ConfigScope
  isAuthenticated?: boolean
  [key: string]: unknown
}

export interface AgentMcpServerInfo {
  type: 'agent'
  name: string
  scope: ConfigScope
  transport?: 'http' | 'sse' | 'stdio' | 'ws'
  url?: string
  command?: string
  args?: string[]
  sourceAgents: string[]
  needsAuth?: boolean
  isAuthenticated?: boolean
}

export type ServerInfo =
  | StdioServerInfo
  | SSEServerInfo
  | HTTPServerInfo
  | ClaudeAIServerInfo

export type MCPViewState =
  | { type: 'list'; defaultTab?: string }
  | { type: 'server-menu'; server: ServerInfo }
  | { type: 'server-tools'; server: ServerInfo }
  | { type: 'server-tool-detail'; server: ServerInfo; toolIndex: number }
  | { type: 'agent-server-menu'; agentServer: AgentMcpServerInfo }
  | { type: 'mcp-tool-detail'; server?: ServerInfo; client: MCPServerConnection; tool: Tool }
