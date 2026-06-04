import type { UUID } from 'crypto'
import type { Attachment } from '../utils/attachments.js'

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type PartialCompactDirection = 'back' | 'forward' | 'from' | 'up_to'

export type MessageOrigin = string

export type SystemMessageLevel = 'info' | 'warning' | 'error' | 'suggestion'

// ---------------------------------------------------------------------------
// Content block placeholders (re-exported Anthropic SDK shapes are complex;
// we use opaque aliases so the rest of the app type-checks without pulling
// in the full SDK types at stub level)
// ---------------------------------------------------------------------------

export interface ContentBlockBase {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  [key: string]: unknown
}

export type ContentBlockParam = ContentBlockBase
export type BetaContentBlock = ContentBlockBase
export interface RecoveredToolUseBlock extends ContentBlockBase {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export type DisplayContentBlock = { type: string }

// ---------------------------------------------------------------------------
// Progress & streaming helpers
// ---------------------------------------------------------------------------

export interface Progress {
  type?: string
  message?: unknown
  output?: string
  fullOutput?: string
  elapsedTimeSeconds?: number
  totalLines?: number
  totalBytes?: number
  timeoutMs?: number
  taskId?: string
  [key: string]: unknown
}

export interface StreamEvent {
  type: 'stream_event'
  event?: unknown
  subtype?: string
  compactMetadata?: CompactMetadata
  retryAttempt?: number
  maxRetries?: number
  retryInMs?: number
  [key: string]: unknown
}

export interface RequestStartEvent {
  type: 'stream_request_start'
  event?: unknown
  subtype?: string
  compactMetadata?: CompactMetadata
  retryAttempt?: number
  maxRetries?: number
  retryInMs?: number
  ttftMs?: number
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Stop-hook metadata
// ---------------------------------------------------------------------------

export interface StopHookInfo {
  hookName?: string
  command?: string
  promptText?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  duration?: number
  durationMs?: number
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
  planContent?: string
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
    container?: unknown
    type?: string
    usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
      [key: string]: any
    }
    context_management?: unknown
    [key: string]: any
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
  content?: string
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
  [key: string]: any
}

export interface SystemAwaySummaryMessage extends SystemBase {
  subtype: 'away_summary'
  [key: string]: any
}

export interface SystemBridgeStatusMessage extends SystemBase {
  subtype: 'bridge_status'
  [key: string]: any
}

export interface SystemCompactBoundaryMessage extends SystemBase {
  subtype: 'compact_boundary'
  [key: string]: any
}

export interface SystemInformationalMessage extends SystemBase {
  subtype: 'informational'
  [key: string]: any
}

export interface SystemLocalCommandMessage extends SystemBase {
  subtype: 'local_command'
  [key: string]: any
}

export interface SystemMemorySavedMessage extends SystemBase {
  subtype: 'memory_saved'
  writtenPaths?: string[]
  [key: string]: any
}

export interface SystemMicrocompactBoundaryMessage extends SystemBase {
  subtype: 'microcompact_boundary'
  [key: string]: any
}

export interface SystemPermissionRetryMessage extends SystemBase {
  subtype: 'permission_retry'
  [key: string]: any
}

export interface SystemScheduledTaskFireMessage extends SystemBase {
  subtype: 'scheduled_task_fire'
  [key: string]: any
}

export interface SystemStopHookSummaryMessage extends SystemBase {
  subtype: 'stop_hook_summary'
  hookCount: number
  hookInfos: StopHookInfo[]
  hookErrors: string[]
  preventedContinuation?: boolean
  stopReason?: string
  totalDurationMs?: number
  hookLabel?: string
  [key: string]: any
}

export interface SystemThinkingMessage extends SystemBase {
  subtype: 'thinking'
  [key: string]: any
}

export interface SystemTurnDurationMessage extends SystemBase {
  subtype: 'turn_duration'
  durationMs?: number
  budgetTokens?: number
  [key: string]: any
}

export interface SystemAgentsKilledMessage extends SystemBase {
  subtype: 'agents_killed'
  [key: string]: any
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
  attachment: Attachment
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
  [key: string]: any
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
      [key: string]: any
    }
    context_management?: unknown
    [key: string]: any
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
  displayMessage?: NormalizedAssistantMessage<DisplayContentBlock> | NormalizedUserMessage
  messageId?: string
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
  relevantMemories?: Array<{ path: string; content: string }>
  readCount?: number
  readFilePaths?: string[]
  searchCount?: number
  searchArgs?: Array<{ pattern?: string; path?: string; content?: string } | string>
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
  pushes?: Array<{ kind?: string; sha?: string; branch?: string }>
  prs?: Array<{ action?: string; number?: number; url?: string }>
  commits?: Array<{ kind?: string; sha?: string; message?: string }>
  branches?: Array<{ action?: string; ref?: string }>
  [key: string]: any
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
  [key: string]: any
}

export interface SystemFileSnapshotMessage extends SystemBase {
  subtype: 'file_snapshot'
  [key: string]: any
}
