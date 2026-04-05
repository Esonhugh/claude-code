// Internal tool types - not yet part of the public SDK API
// Tool definitions are handled by SdkMcpToolDefinition in runtimeTypes.ts

export type ToolInput = Record<string, unknown>
export type ToolResult = {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>
  isError?: boolean
}
