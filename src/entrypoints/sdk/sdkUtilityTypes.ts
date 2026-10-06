import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

export type UsageWithOutputTokenDetails = BetaUsage & {
  output_tokens_details?: { thinking_tokens?: number | null } | null
}

export type NonNullableUsage = {
  [K in keyof BetaUsage]: NonNullable<BetaUsage[K]>
} & {
  output_tokens_details: { thinking_tokens: number }
}
