import { isDeepStrictEqual } from 'node:util'
import type { ModSnapshot } from './runtime.js'
import type { ModOrigin } from './types.js'

type Report = {agentId: string; subagentType: string; parentAgentId?: string; provider: ModOrigin; status: 'completed' | 'failed' | 'stopped'; text: string}
type Review = {review: 'cleared' | 'flagged' | 'refused' | 'unavailable' | 'none' | 'off'; warning?: string}

export async function deliverAgentReport(snapshot: ModSnapshot, input: Report, reviewOriginal: () => Promise<Review>): Promise<{text:string; review:Review['review']; warning?:string} | {consumed:string; warning?:string}> {
  // Reviewing is independent of next(): even a replacement or consumption cannot cancel it.
  const review = reviewOriginal()
  const [result, receipt] = await Promise.all([snapshot.dispatch('agent.report', input, async value => ({text:value.text, ...await review}), {
    validateInput(value) {
      if (typeof value.text !== 'string' || !isDeepStrictEqual({...value, text:input.text}, input)) throw new Error('agent.report can only rewrite text')
    },
  }) as Promise<{text:string} | {consumed:string}>, review])
  return 'consumed' in result ? {consumed:result.consumed, ...(receipt.warning && {warning:receipt.warning})} : {text:result.text,...receipt}
}
