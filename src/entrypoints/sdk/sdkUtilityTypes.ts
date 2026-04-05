import type { ModelUsage } from './coreTypes.generated.js'

export type NonNullableUsage = {
  [K in keyof ModelUsage]: NonNullable<ModelUsage[K]>
} & {
  // Allow additional snake_case properties from API response
  [key: string]: unknown
}
