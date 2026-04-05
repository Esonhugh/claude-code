export interface StdioServerInfo {
  command: string
  args: string[]
  type?: 'stdio'
  env?: Record<string, string>
  scope: string
  pluginSource?: string
  [key: string]: unknown
}

export interface SSEServerInfo {
  url: string
  type: 'sse'
  scope: string
  [key: string]: unknown
}

export interface HTTPServerInfo {
  url: string
  type: 'http'
  scope: string
  [key: string]: unknown
}

export interface ClaudeAIServerInfo {
  type: 'claude_ai'
  name: string
  scope: string
  [key: string]: unknown
}

export interface AgentMcpServerInfo {
  type: 'agent'
  name: string
  scope: string
  [key: string]: unknown
}

export type ServerInfo = StdioServerInfo | SSEServerInfo | HTTPServerInfo | ClaudeAIServerInfo | AgentMcpServerInfo

export type MCPViewState = string
