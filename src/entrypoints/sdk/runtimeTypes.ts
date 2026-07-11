import type {
  SDKMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SDKUserMessage,
  PermissionMode,
  McpServerConfigForProcessTransport,
  OutputFormat,
  ThinkingConfig,
  AgentDefinition,
  SdkPluginConfig,
  PermissionUpdate,
} from './coreTypes.generated.js'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyZodRawShape = Record<string, any>
export type InferShape<Schema extends AnyZodRawShape> = {
  [K in keyof Schema]: unknown
}

export type SdkMcpToolDefinition<Schema extends AnyZodRawShape = AnyZodRawShape> = {
  name: string
  description: string
  inputSchema: Schema
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<unknown>
  extras?: {
    annotations?: unknown
    searchHint?: string
    alwaysLoad?: boolean
  }
}

export type McpSdkServerConfigWithInstance = {
  type: 'sdk'
  name: string
  instance: unknown
}

export type Options = {
  model?: string
  maxTurns?: number
  maxBudgetUsd?: number
  maxThinkingTokens?: number
  thinkingConfig?: ThinkingConfig
  systemPrompt?: string
  appendSystemPrompt?: string
  permissionMode?: PermissionMode
  permissionPromptToolName?: string
  abortController?: AbortController
  cwd?: string
  mcpServers?: Record<string, McpServerConfigForProcessTransport>
  sdkMcpServers?: McpSdkServerConfigWithInstance[]
  allowedTools?: string[]
  disallowedTools?: string[]
  outputFormat?: OutputFormat
  agents?: Record<string, AgentDefinition>
  signal?: AbortSignal
  enableRemoteControl?: boolean
  enableAskUserQuestion?: boolean
  promptSuggestions?: boolean
  continueConversation?: boolean
  resume?: boolean
  sessionId?: string
  sessionName?: string
  effort?: EffortLevel
  plugins?: SdkPluginConfig[]
  settingsOverrides?: Record<string, unknown>
  hooks?: Record<string, unknown>
}

export type InternalOptions = Options & {
  _internal?: boolean
  [key: string]: unknown
}

export interface Query extends AsyncIterable<SDKMessage> {
  abort(): void
  result: Promise<SDKResultMessage>
}

export interface InternalQuery extends AsyncIterable<SDKMessage> {
  abort(): void
  result: Promise<SDKResultMessage>
}

export type SDKSessionOptions = {
  model?: string
  maxTurns?: number
  maxBudgetUsd?: number
  systemPrompt?: string
  appendSystemPrompt?: string
  permissionMode?: PermissionMode
  cwd?: string
  mcpServers?: Record<string, McpServerConfigForProcessTransport>
  allowedTools?: string[]
  disallowedTools?: string[]
  agents?: Record<string, AgentDefinition>
  signal?: AbortSignal
  effort?: EffortLevel
  sessionId?: string
}

export interface SDKSession {
  readonly sessionId: string
  send(message: string | AsyncIterable<SDKUserMessage>): Query
  close(): Promise<void>
}

export type ListSessionsOptions = {
  dir?: string
  limit?: number
  offset?: number
}

export type GetSessionInfoOptions = {
  dir?: string
}

export type GetSessionMessagesOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}

export type SessionMutationOptions = {
  dir?: string
}

export type ForkSessionOptions = {
  dir?: string
  upToMessageId?: string
  title?: string
}

export type ForkSessionResult = {
  sessionId: string
}

export type SessionMessage = SDKMessage & {
  parentUuid?: string
}
