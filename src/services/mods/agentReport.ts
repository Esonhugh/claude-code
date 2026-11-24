import { isDeepStrictEqual } from 'node:util'
import type { ModSnapshot } from './runtime.js'
import type { ModOrigin } from './types.js'

type Report = {agentId: string; subagentType: string; parentAgentId?: string; provider: ModOrigin; status: 'completed' | 'failed' | 'stopped'; text: string}
type Review = {review: 'cleared' | 'flagged' | 'refused' | 'unavailable' | 'none' | 'off'; warning?: string}

export async function deliverAgentReport(snapshot: ModSnapshot, input: Report, reviewOriginal: () => Promise<Review>): Promise<{text:string; review:Review['review']; warning?:string} | {consumed:string}> {
  // Reviewing is independent of next(): even a replacement or consumption cannot cancel it.
  const review = reviewOriginal()
  const [result, receipt] = await Promise.all([snapshot.dispatch('agent.report', input, async value => ({text:value.text, ...await review}), {
    validateInput(value) {
      if (typeof value.text !== 'string' || !isDeepStrictEqual({...value, text:input.text}, input)) throw new Error('agent.report can only rewrite text')
    },
    restoreResult(value, previous, called) {
      if (!value || typeof value !== 'object') return value
      const {review, warning, ...answer} = value as Partial<Review> & {consumed?:unknown}
      const below = previous as Partial<Review> | undefined
      if (answer.consumed !== undefined || !called || !below?.review) return answer
      return {...answer, review:below.review, ...(below.warning && {warning:below.warning})}
    },
  }) as Promise<{text:string} | {consumed:string}>, review])
  const pending = snapshot.agentReportWarnings
  const warning = [pending?.get(input.agentId), receipt.warning].filter(Boolean).join('\n')
  if ('consumed' in result) {
    if (warning) pending?.set(input.agentId, warning)
    return {consumed:result.consumed}
  }
  pending?.delete(input.agentId)
  return {text:result.text, review:receipt.review, ...(warning && {warning})}
}
