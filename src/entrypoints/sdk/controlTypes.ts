import type {
  SDKMessage,
  SDKUserMessage,
  PermissionMode,
  McpServerConfigForProcessTransport,
  PermissionResult,
  McpServerStatus,
  McpSetServersResult,
  RewindFilesResult,
  SlashCommand,
  AgentInfo,
  ModelInfo,
  AccountInfo,
  HookEvent,
  AgentDefinition,
  PermissionUpdate,
} from './coreTypes.generated.js'

// Keep alive
export type SDKKeepAliveMessage = {
  type: 'keep_alive'
}

// Environment variables update
export type SDKUpdateEnvironmentVariablesMessage = {
  type: 'update_environment_variables'
  variables: Record<string, string>
}

// Hook callback matcher
export type SDKHookCallbackMatcher = {
  matcher?: string
  hookCallbackIds: string[]
  timeout?: number
}

// Control Request inner types - use `subtype` as discriminant (matches recovered code)
export type SDKControlInitializeRequest = {
  subtype: 'initialize'
  protocolVersion?: string
  hooks?: Record<string, unknown>
  mcpServers?: Record<string, McpServerConfigForProcessTransport>
  sdkMcpServers?: unknown[]
  hookCallbackMatchers?: SDKHookCallbackMatcher[]
  agents?: Record<string, AgentDefinition>
  permissionUpdates?: PermissionUpdate[]
  loginWithClaudeAi?: boolean
  promptSuggestions?: boolean
  agentProgressSummaries?: boolean
  [key: string]: unknown
}

export type SDKControlInitializeResponse = {
  commands: SlashCommand[]
  models: ModelInfo[]
  agents: AgentInfo[]
  account: AccountInfo
}

export type SDKControlInterruptRequest = {
  subtype: 'interrupt'
}

export type SDKControlPermissionRequest = {
  subtype: 'permission'
  tool_name: string
  tool_input: Record<string, unknown>
  tool_use_id: string
  permissionResult: PermissionResult
  [key: string]: unknown
}

export type SDKControlSetPermissionModeRequest = {
  subtype: 'set_permission_mode'
  mode: PermissionMode
}

export type SDKControlSetModelRequest = {
  subtype: 'set_model'
  model: string
}

export type SDKControlSetMaxThinkingTokensRequest = {
  subtype: 'set_max_thinking_tokens'
  max_thinking_tokens: number
}

export type SDKControlMcpStatusRequest = {
  subtype: 'mcp_status'
}

export type SDKControlMcpStatusResponse = {
  servers: McpServerStatus[]
}

export type SDKControlGetContextUsageRequest = {
  subtype: 'get_context_usage'
}

export type SDKControlGetContextUsageResponse = {
  totalTokens: number
  contextWindow: number
  percentUsed: number
}

export type SDKControlRewindFilesRequest = {
  subtype: 'rewind_files'
  message_uuid?: string
  messageId?: string
}

export type SDKControlRewindFilesResponse = RewindFilesResult

export type SDKControlCancelAsyncMessageRequest = {
  subtype: 'cancel_async_message'
  user_message_id?: string
  messageId?: string
}

export type SDKControlCancelAsyncMessageResponse = {
  success: boolean
}

export type SDKControlSeedReadStateRequest = {
  subtype: 'seed_read_state'
  files: Record<string, string | { content: string; mtime?: number }>
}

export type SDKHookCallbackRequest = {
  subtype: 'hook_callback'
  hookCallbackId: string
  hookEvent: HookEvent
  response: Record<string, unknown>
}

export type SDKControlMcpMessageRequest = {
  subtype: 'mcp_message'
  server_name?: string
  serverName?: string
  message: unknown
}

export type SDKControlMcpSetServersRequest = {
  subtype: 'mcp_set_servers'
  servers: Record<string, McpServerConfigForProcessTransport>
}

export type SDKControlMcpSetServersResponse = McpSetServersResult

export type SDKControlReloadPluginsRequest = {
  subtype: 'reload_plugins'
}

export type SDKControlReloadPluginsResponse = {
  success: boolean
}

export type SDKControlMcpReconnectRequest = {
  subtype: 'mcp_reconnect'
  server_name?: string
  serverName?: string
}

export type SDKControlMcpToggleRequest = {
  subtype: 'mcp_toggle'
  server_name?: string
  serverName?: string
  enabled: boolean
}

export type SDKControlStopTaskRequest = {
  subtype: 'stop_task'
  task_id: string
}

export type SDKControlApplyFlagSettingsRequest = {
  subtype: 'apply_flag_settings'
  settings: Record<string, unknown>
}

export type SDKControlGetSettingsRequest = {
  subtype: 'get_settings'
}

export type SDKControlGetSettingsResponse = {
  settings: Record<string, unknown>
}

export type SDKControlElicitationRequest = {
  subtype: 'elicitation'
  elicitationId: string
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}

export type SDKControlElicitationResponse = {
  success: boolean
}

// Union of all control request inner types
export type SDKControlRequestInner = {
  subtype: string
  [key: string]: unknown
}

// Control Request/Response wrappers
export type SDKControlRequest = {
  type: 'control_request'
  request_id: string
  request: SDKControlRequestInner
}

export type ControlResponse = {
  subtype: 'success'
  request_id: string
  response?: Record<string, unknown>
}

export type ControlErrorResponse = {
  subtype: 'error'
  request_id: string
  error: string
}

export type SDKControlResponse = {
  type: 'control_response'
  response: ControlResponse | ControlErrorResponse
}

export type SDKControlCancelRequest = {
  type: 'control_cancel_request'
  request_id: string
}

// Composite message types for stdio transport
export type StdoutMessage = SDKMessage | SDKControlResponse | SDKControlRequest | SDKKeepAliveMessage
export type StdinMessage = SDKUserMessage | SDKControlRequest | SDKControlResponse | SDKKeepAliveMessage | SDKUpdateEnvironmentVariablesMessage | SDKControlCancelRequest
