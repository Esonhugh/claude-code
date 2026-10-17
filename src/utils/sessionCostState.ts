import type { UUID } from 'crypto'
import { z } from 'zod'
import {
  getModelUsage,
  getSessionId,
  getSessionStartTime,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalCostUSD,
  getTotalDuration,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalToolDuration,
  hasUnknownModelCost,
} from '../bootstrap/state.js'
import type { SessionCostStateEntry } from '../types/logs.js'

// The 2.1.291 transcript reader admits only complete, bounded cost snapshots.
const limit = 1e15
const nonnegative = z.number().finite().nonnegative().max(limit)
const costStateSchema: z.ZodType<Omit<SessionCostStateEntry, 'sessionId'> & { sessionId: string }> = z.object({
  type: z.literal('cost-state'),
  sessionId: z.string(),
  totalCostUSD: nonnegative.max(1e9),
  totalAPIDuration: nonnegative,
  totalAPIDurationWithoutRetries: nonnegative,
  totalToolDuration: nonnegative,
  totalLinesAdded: nonnegative,
  totalLinesRemoved: nonnegative,
  totalDuration: nonnegative,
  startTime: nonnegative,
  modelUsage: z
    .record(
      z.string().regex(/^[^\p{Cc}\p{Cf}]+$/u),
      z.object({
        inputTokens: nonnegative,
        outputTokens: nonnegative,
        thinkingTokens: nonnegative.optional(),
        cacheReadInputTokens: nonnegative,
        cacheCreationInputTokens: nonnegative,
        webSearchRequests: nonnegative,
        costUSD: nonnegative,
      }),
    )
    .refine((models) =>
      (
        [
          'inputTokens',
          'outputTokens',
          'cacheReadInputTokens',
          'cacheCreationInputTokens',
        ] as const
      ).every(
        (key) =>
          Object.values(models).reduce((sum, model) => sum + model[key], 0) <=
          limit,
      ),
    ),
  hasUnknownModelCost: z.boolean().optional(),
})

export function parseSessionCostState(
  value: unknown,
): SessionCostStateEntry | undefined {
  const result = costStateSchema.safeParse(value)
  return result.success ? { ...result.data, sessionId: result.data.sessionId as UUID } : undefined
}

/** Capture wire fields only; runtime model limits are rebuilt during restore. */
export function captureSessionCostState(): SessionCostStateEntry {
  return {
    type: 'cost-state',
    sessionId: getSessionId() as UUID,
    totalCostUSD: getTotalCostUSD(),
    totalAPIDuration: getTotalAPIDuration(),
    totalAPIDurationWithoutRetries: getTotalAPIDurationWithoutRetries(),
    totalToolDuration: getTotalToolDuration(),
    totalLinesAdded: getTotalLinesAdded(),
    totalLinesRemoved: getTotalLinesRemoved(),
    totalDuration: getTotalDuration(),
    startTime: getSessionStartTime(),
    modelUsage: Object.fromEntries(Object.entries(getModelUsage()).map(([model, usage]) => [model, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      thinkingTokens: usage.thinkingTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      webSearchRequests: usage.webSearchRequests,
      costUSD: usage.costUSD,
    }])),
    hasUnknownModelCost: hasUnknownModelCost(),
  }
}
