import type { UUID } from 'crypto'

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type PartialCompactDirection = 'back' | 'forward'

export type MessageOrigin = string

export type SystemMessageLevel = 'info' | 'warning' | 'error'

// ---------------------------------------------------------------------------
// Content block placeholders (re-exported Anthropic SDK shapes are complex;
// we use opaque aliases so the rest of the app type-checks without pulling
// in the full SDK types at stub level)
// ---------------------------------------------------------------------------

interface ContentBlockBase {
  type: string
  [key: string]: unknown
}

type ContentBlockParam = ContentBlockBase
type BetaContentBlock = ContentBlockBase
type BetaToolUseBlock = ContentBlockBase & {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

// ---------------------------------------------------------------------------
// Progress & streaming helpers
// ---------------------------------------------------------------------------

export interface Progress {
  [key: string]: unknown
}

export interface StreamEvent {
  [key: string]: unknown
}

export interface RequestStartEvent {
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Stop-hook metadata
// ---------------------------------------------------------------------------

export interface StopHookInfo {
  hookName: string
  exitCode: number
  stdout?: string
  stderr?: string
  duration?: number
}

// ---------------------------------------------------------------------------
// Core message types (discriminated union on `type`)
// ---------------------------------------------------------------------------

export interface UserMessage {
  type: 'user'
  uuid: UUID
  timestamp: string
  message: {
    role: 'user'
    content: string | ContentBlockParam[]
  }
  isMeta?: boolean
  isVisibleInTranscriptOnly?: boolean
  isVirtual?: boolean
  isCompactSummary?: boolean
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
  }
  toolUseResult?: unknown
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  imagePasteIds?: number[]
  sourceToolAssistantUUID?: UUID
  permissionMode?: unknown
  origin?: MessageOrigin
}

export interface AssistantMessage {
  type: 'assistant'
  uuid: UUID
  timestamp: string
  message: {
    id: string
    role: 'assistant'
    model: string
    content: BetaContentBlock[]
    stop_reason: string
    stop_sequence: string | null
    usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
      [key: string]: unknown
    }
    context_management?: unknown
  }
  requestId?: string
  isMeta?: boolean
  isVirtual?: boolean
  isApiErrorMessage?: boolean
  apiError?: {
    status: number
    type: string
    message: string
  }
  error?: unknown
  errorDetails?: string
  advisorModel?: string
}

// ---------------------------------------------------------------------------
// System message subtypes
// ---------------------------------------------------------------------------

interface SystemBase {
  type: 'system'
  uuid: UUID
  timestamp: string
  level?: SystemMessageLevel
  message?: { content?: BetaContentBlock[] }
}

export interface SystemAPIErrorMessage extends SystemBase {
  subtype: 'api_error'
  error?: unknown
  retryInMs?: number
  retryAttempt?: number
  maxRetries?: number
}

export interface SystemApiMetricsMessage extends SystemBase {
  subtype: 'api_metrics'
  [key: string]: unknown
}

export interface SystemAwaySummaryMessage extends SystemBase {
  subtype: 'away_summary'
  [key: string]: unknown
}

export interface SystemBridgeStatusMessage extends SystemBase {
  subtype: 'bridge_status'
  [key: string]: unknown
}

export interface SystemCompactBoundaryMessage extends SystemBase {
  subtype: 'compact_boundary'
  [key: string]: unknown
}

export interface SystemInformationalMessage extends SystemBase {
  subtype: 'informational'
  [key: string]: unknown
}

export interface SystemLocalCommandMessage extends SystemBase {
  subtype: 'local_command'
  [key: string]: unknown
}

export interface SystemMemorySavedMessage extends SystemBase {
  subtype: 'memory_saved'
  writtenPaths?: string[]
  [key: string]: unknown
}

export interface SystemMicrocompactBoundaryMessage extends SystemBase {
  subtype: 'microcompact_boundary'
  [key: string]: unknown
}

export interface SystemPermissionRetryMessage extends SystemBase {
  subtype: 'permission_retry'
  [key: string]: unknown
}

export interface SystemScheduledTaskFireMessage extends SystemBase {
  subtype: 'scheduled_task_fire'
  [key: string]: unknown
}

export interface SystemStopHookSummaryMessage extends SystemBase {
  subtype: 'stop_hook_summary'
  hookCount?: number
  hookInfos?: StopHookInfo[]
  [key: string]: unknown
}

export interface SystemThinkingMessage extends SystemBase {
  subtype: 'thinking'
  [key: string]: unknown
}

export interface SystemTurnDurationMessage extends SystemBase {
  subtype: 'turn_duration'
  durationMs?: number
  budgetTokens?: number
  [key: string]: unknown
}

export interface SystemAgentsKilledMessage extends SystemBase {
  subtype: 'agents_killed'
  [key: string]: unknown
}

export type SystemMessage =
  | SystemAPIErrorMessage
  | SystemApiMetricsMessage
  | SystemAwaySummaryMessage
  | SystemBridgeStatusMessage
  | SystemCompactBoundaryMessage
  | SystemInformationalMessage
  | SystemLocalCommandMessage
  | SystemMemorySavedMessage
  | SystemMicrocompactBoundaryMessage
  | SystemPermissionRetryMessage
  | SystemScheduledTaskFireMessage
  | SystemStopHookSummaryMessage
  | SystemThinkingMessage
  | SystemTurnDurationMessage
  | SystemAgentsKilledMessage

// ---------------------------------------------------------------------------
// Progress message (generic over progress data shape)
// ---------------------------------------------------------------------------

export interface ProgressMessage<T extends Progress = Progress> {
  type: 'progress'
  uuid: UUID
  timestamp: string
  toolUseID: string
  parentToolUseID: string
  data: T
}

// ---------------------------------------------------------------------------
// Attachment message
// ---------------------------------------------------------------------------

export interface AttachmentMessage {
  type: 'attachment'
  uuid: UUID
  timestamp: string
  attachment: unknown
}

// ---------------------------------------------------------------------------
// Hook result message
// ---------------------------------------------------------------------------

export interface HookResultMessage {
  type: 'hook_result'
  uuid: UUID
  timestamp: string
  hookName?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Tombstone & tool-use summary (internal bookkeeping)
// ---------------------------------------------------------------------------

export interface TombstoneMessage {
  type: 'tombstone'
  uuid: UUID
  timestamp: string
  isPlaceholder?: boolean
}

export interface ToolUseSummaryMessage {
  type: 'tool_use_summary'
  uuid: UUID
  timestamp: string
  toolUseID: string
  summary: string
}

// ---------------------------------------------------------------------------
// Normalized messages (each content block becomes its own message)
// ---------------------------------------------------------------------------

export interface NormalizedAssistantMessage<T = BetaContentBlock> {
  type: 'assistant'
  uuid: UUID
  timestamp: string
  message: {
    id: string
    role: 'assistant'
    model: string
    content: [T]
    stop_reason: string
    stop_sequence: string | null
    usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
      [key: string]: unknown
    }
    context_management?: unknown
  }
  requestId?: string
  isMeta?: boolean
  isVirtual?: boolean
  isApiErrorMessage?: boolean
  apiError?: {
    status: number
    type: string
    message: string
  }
  error?: unknown
  errorDetails?: string
  advisorModel?: string
}

export type NormalizedUserMessage = UserMessage & {
  message: {
    role: 'user'
    content: ContentBlockParam[]
  }
}

export type NormalizedMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | AttachmentMessage
  | SystemMessage
  | ProgressMessage

// ---------------------------------------------------------------------------
// Display grouping types
// ---------------------------------------------------------------------------

export interface GroupedToolUseMessage {
  type: 'grouped_tool_use'
  uuid: UUID
  timestamp: string
  toolName: string
  messages: NormalizedAssistantMessage[]
  results: NormalizedUserMessage[]
}

export interface CollapsedReadSearchGroup {
  type: 'collapsed_read_search'
  uuid: UUID
  timestamp: string
  count: number
  isCollapsed: boolean
  messages: RenderableMessage[]
  message?: NormalizedAssistantMessage
  displayMessage?: string
  latestDisplayHint?: string
  hookTotalMs?: number
  hookCount?: number
  hookInfos?: StopHookInfo[]
  relevantMemories?: unknown[]
  readCount?: number
  readFilePaths?: string[]
  searchCount?: number
  searchArgs?: unknown[]
  listCount?: number
  replCount?: number
  bashCount?: number
  gitOpBashCount?: number
  mcpCallCount?: number
  mcpServerNames?: string[]
  memoryReadCount?: number
  memoryWriteCount?: number
  memorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
  teamMemorySearchCount?: number
  pushes?: unknown[]
  prs?: unknown[]
  commits?: unknown[]
  branches?: unknown[]
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Renderable message (union of all display-ready types)
// ---------------------------------------------------------------------------

export type RenderableMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | AttachmentMessage
  | SystemMessage
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup
  | ProgressMessage

// ---------------------------------------------------------------------------
// Queue operation message (for async message queue)
// ---------------------------------------------------------------------------

export interface QueueOperationMessage {
  type: 'queue-operation'
  operation: string
  timestamp: string
  sessionId: string
  content?: string
}

// ---------------------------------------------------------------------------
// Top-level Message union
// ---------------------------------------------------------------------------

export type Message =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ProgressMessage
  | AttachmentMessage
  | HookResultMessage
  | TombstoneMessage
  | ToolUseSummaryMessage
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup

// Additional types referenced by the codebase
export type CollapsibleMessage = NormalizedAssistantMessage | GroupedToolUseMessage

export interface CompactMetadata {
  messagesSummarized?: number
  userContext?: string
  direction?: PartialCompactDirection
  [key: string]: unknown
}

export interface SystemFileSnapshotMessage extends SystemBase {
  subtype: 'file_snapshot'
  [key: string]: unknown
}
