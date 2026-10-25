import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import type { Message } from '../types/message.js'
import { cleanAssistantDisplayText } from '../utils/assistantDisplayText.js'
import { logForDebugging } from '../utils/debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../utils/envUtils.js'
import {
  type CacheSafeParams,
  getLastCacheSafeParams,
  runForkedAgent,
} from '../utils/forkedAgent.js'
import { createUserMessage } from '../utils/messages.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { getSessionMemoryContent } from './SessionMemory/sessionMemoryUtils.js'

const RECAP_PROMPT =
  'The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.'

export const MAX_RECAP_CHARS = 400

export type AwaySummaryResult =
  | { kind: 'ok'; text: string; capped: boolean }
  | { kind: 'api-error'; text: string }
  | { kind: 'no-turn' }
  | { kind: 'aborted' }
  | { kind: 'failed' }

/**
 * Whether the automatic "while you were away" recap runs. Enabled by default;
 * CLAUDE_CODE_ENABLE_AWAY_SUMMARY forces it on or off, and the
 * awaySummaryEnabled setting can turn it off.
 */
export function isAwaySummaryEnabled(): boolean {
  const envVal = process.env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY
  if (isEnvDefinedFalsy(envVal)) return false
  if (isEnvTruthy(envVal)) return true
  if (getIsNonInteractiveSession()) return false
  return getInitialSettings().awaySummaryEnabled !== false
}

function buildAwaySummaryPrompt(memory: string | null): string {
  return memory
    ? `Session memory (broader context):\n${memory}\n\n${RECAP_PROMPT}`
    : RECAP_PROMPT
}

/** Cut at a word boundary and append an ellipsis when over the cap. */
export function capRecapText(text: string, max = MAX_RECAP_CHARS): string {
  const chars = [...text]
  if (chars.length <= max) return text
  const head = chars.slice(0, max - 1).join('')
  const boundary = head.search(/\s\S*$/)
  const atWord = boundary === -1 ? '' : head.slice(0, boundary).trimEnd()
  return `${atWord.length > max / 2 ? atWord : head.trimEnd()}\u2026`
}

function collectText(messages: readonly Message[], includeErrors: boolean): string {
  const text = messages
    .flatMap(m =>
      m.type === 'assistant' && (includeErrors || !m.isApiErrorMessage)
        ? m.message.content
        : [],
    )
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('')
  return cleanAssistantDisplayText(text).trim()
}

/**
 * Generates a short session recap by forking the main conversation with its
 * saved cache-safe params, so it runs on the main loop model and provider
 * (OpenAI included) and reuses the prompt cache. buildFallbackParams rebuilds
 * the params when no turn has completed in this process yet (e.g. resume).
 */
export async function generateAwaySummary(
  signal: AbortSignal,
  buildFallbackParams?: () => Promise<CacheSafeParams | null>,
): Promise<AwaySummaryResult> {
  let params = getLastCacheSafeParams()
  if (!params && buildFallbackParams) {
    if (signal.aborted) return { kind: 'aborted' }
    try {
      params = await buildFallbackParams()
    } catch (err) {
      logForDebugging(`[awaySummary] fallback params rebuild failed: ${err}`)
      return { kind: 'failed' }
    }
    if (signal.aborted) return { kind: 'aborted' }
  }
  if (!params || params.forkContextMessages.length === 0) {
    logForDebugging('[awaySummary] no CacheSafeParams saved, skipping')
    return { kind: 'no-turn' }
  }

  const abortController = new AbortController()
  signal.addEventListener('abort', () => abortController.abort(), {
    once: true,
  })
  try {
    const memory = await getSessionMemoryContent()
    const { messages } = await runForkedAgent({
      promptMessages: [
        createUserMessage({ content: buildAwaySummaryPrompt(memory) }),
      ],
      cacheSafeParams: params,
      overrides: { abortController },
      canUseTool: async () => ({
        behavior: 'deny' as const,
        message: 'Away summary cannot use tools',
        decisionReason: { type: 'other' as const, reason: 'away_summary' },
      }),
      querySource: 'away_summary',
      forkLabel: 'away_summary',
      maxTurns: 1,
      skipCacheWrite: true,
      skipTranscript: true,
    })
    if (signal.aborted) return { kind: 'aborted' }
    const apiError = messages.find(
      m => m.type === 'assistant' && m.isApiErrorMessage,
    )
    if (apiError) {
      return { kind: 'api-error', text: collectText([apiError], true) }
    }
    const text = collectText(messages, false)
    if (!text) return { kind: 'failed' }
    const capped = capRecapText(text)
    if (capped !== text) {
      logForDebugging(
        `[awaySummary] recap capped from ${text.length} to ${capped.length} chars`,
      )
    }
    return { kind: 'ok', text: capped, capped: capped !== text }
  } catch (err) {
    if (signal.aborted) return { kind: 'aborted' }
    logForDebugging(`[awaySummary] generation failed: ${err}`)
    return { kind: 'failed' }
  }
}
