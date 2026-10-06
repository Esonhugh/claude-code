import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

export type NonNullableUsage = {
  [K in keyof BetaUsage]: NonNullable<BetaUsage[K]>
}
