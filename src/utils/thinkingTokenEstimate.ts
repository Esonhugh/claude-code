type StreamEvent = {
  type: string
  delta?: {
    type: string
    thinking?: string
    estimated_tokens?: number | null
    signature?: string
  }
}

export type ThinkingEstimateStep = {
  estimate: number
  emission: { estimatedTokens: number; estimatedTokensDelta: number } | null
}

/**
 * Running thinking-token estimate for the SDK `system/thinking_tokens`
 * message, matching official 2.1.311: the API's thinking_delta
 * estimated_tokens (or visible text at 4 chars/token) adds up per content
 * block, and a signature larger than the running total raises it.
 */
export function nextThinkingEstimate(
  estimate: number,
  event: StreamEvent,
): ThinkingEstimateStep {
  if (event.type === 'content_block_start') return { estimate: 0, emission: null }
  const delta = event.type === 'content_block_delta' ? event.delta : undefined
  if (delta?.type === 'thinking_delta') {
    const added =
      typeof delta.estimated_tokens === 'number'
        ? delta.estimated_tokens
        : delta.thinking
          ? Math.ceil(delta.thinking.length / 4)
          : undefined
    if (added === undefined) return { estimate, emission: null }
    const total = estimate + added
    return {
      estimate: total,
      emission: { estimatedTokens: total, estimatedTokensDelta: added },
    }
  }
  if (delta?.type === 'signature_delta' && delta.signature && estimate > 0) {
    const fromSignature = Math.ceil(Math.round(delta.signature.length * 0.75) / 4)
    if (fromSignature > estimate) {
      return {
        estimate: fromSignature,
        emission: {
          estimatedTokens: fromSignature,
          estimatedTokensDelta: fromSignature - estimate,
        },
      }
    }
  }
  return { estimate, emission: null }
}
