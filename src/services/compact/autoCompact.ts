import type { SDKAutocompactStateMessage } from '../../entrypoints/agentSdkTypes.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { feature } from 'bun:bundle'
import { getSdkBetas, markPostCompaction } from 'src/bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import {
  getContextWindowForModel,
  resolveContextWindow,
} from '../../utils/context.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage, hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { getCanonicalName } from '../../utils/model/model.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { getEnabledSettingSources } from '../../utils/settings/constants.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'
import { logError } from '../../utils/log.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  CompactionBlockedError,
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
  type RecompactionInfo,
} from './compact.js'
import {
  getCodexCompactOptions,
  getCompactMode,
} from './compactMode.js'
import { compactConversationCodexStyle } from './codexCompact.js'
import {
  classifierOverflowReminder,
  takeClassifierOverflowCompaction,
} from './classifierOverflow.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'
import { runModSessionCompact } from '../mods/compactAdapter.js'

// Reserve this many tokens for output during compaction
// Based on p99.99 of compact summary output being 17,387 tokens.
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

/** Settings key for per-model values: canonical name without the [1m] suffix. */
export function getAutoCompactWindowModelKey(model: string): string {
  return getCanonicalName(model).replace(/\[1m\]$/i, '')
}

/**
 * Official F9t/Ob: walk settings sources from low to high priority. A
 * source's top-level autoCompactWindow replaces per-model values from lower
 * sources; within a source, modelSettings.<model>.autoCompactWindow wins.
 * Returns undefined for "auto".
 */
export function getConfiguredAutoCompactWindow(
  model: string,
): number | undefined {
  const key = getAutoCompactWindowModelKey(model)
  let topLevel: number | undefined
  let perModel: number | 'auto' | undefined
  for (const source of getEnabledSettingSources()) {
    const settings = getSettingsForSource(source)
    if (!settings) continue
    let sourcePerModel: number | 'auto' | undefined
    for (const [name, value] of Object.entries(settings.modelSettings ?? {})) {
      const window = value?.autoCompactWindow
      if (window === undefined) continue
      if (name === key) {
        sourcePerModel = window
        break
      }
      if (getAutoCompactWindowModelKey(name) === key) sourcePerModel ??= window
    }
    if (settings.autoCompactWindow !== undefined) {
      topLevel = settings.autoCompactWindow
      perModel = sourcePerModel
    } else if (sourcePerModel !== undefined) {
      perModel = sourcePerModel
    }
  }
  const configured = perModel ?? topLevel
  return configured === 'auto' ? undefined : configured
}

/**
 * Resolves the auto-compact window. `ceiling` is an agent definition's
 * autoCompactWindow: it can only lower the window, and the environment
 * override still wins.
 */
export function resolveAutoCompactWindow(
  model: string,
  ceiling?: number,
): ReturnType<typeof resolveContextWindow> {
  const resolved = resolveContextWindow(
    model,
    getConfiguredAutoCompactWindow(model),
  )
  if (
    ceiling === undefined ||
    resolved.source === 'env' ||
    resolved.window <= ceiling
  ) {
    return resolved
  }
  return { window: ceiling, source: 'settings' }
}

// Returns the context window size minus the max output tokens for the model
export function getEffectiveContextWindowSize(
  model: string,
  autoCompactWindowCeiling?: number,
): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  const { window } = resolveAutoCompactWindow(model, autoCompactWindowCeiling)

  return window - reservedTokensForSummary
}

export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  // Unique ID per turn
  turnId: string
  // Consecutive autocompact failures. Reset on success.
  // Used as a circuit breaker to stop retrying when the context is
  // irrecoverably over the limit (e.g., prompt_too_long).
  consecutiveFailures?: number
}

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

// Stop trying autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

export function getAutoCompactThreshold(
  model: string,
  autoCompactWindowCeiling?: number,
): number {
  return thresholdForWindow(
    getEffectiveContextWindowSize(model, autoCompactWindowCeiling),
  )
}

function thresholdForWindow(effectiveContextWindow: number): number {
  const autocompactThreshold =
    effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS

  // Override for easier testing of autocompact
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}

/** Official remote-stream projection; the threshold shares the engine calculation. */
export function getAutoCompactState(
  model: string,
  settingsWindow: number | undefined,
  reactiveCompact: boolean,
): SDKAutocompactStateMessage['value'] {
  const enabled = isAutoCompactEnabled()
  const { source } = resolveContextWindow(model, settingsWindow)
  const { window } = resolveContextWindow(model, enabled ? settingsWindow : undefined)
  const effectiveWindow = window - Math.min(getMaxOutputTokensForModel(model), MAX_OUTPUT_TOKENS_FOR_SUMMARY)
  return {
    enabled,
    effective_window: effectiveWindow,
    threshold: thresholdForWindow(effectiveWindow),
    enforced: !(reactiveCompact && source === 'auto'),
    source,
  }
}

export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
  autoCompactWindowCeiling?: number,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(
    model,
    autoCompactWindowCeiling,
  )
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model, autoCompactWindowCeiling)

  const percentLeft = Math.max(
    0,
    Math.round(((threshold - tokenUsage) / threshold) * 100),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold

  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold

  const actualContextWindow = getEffectiveContextWindowSize(
    model,
    autoCompactWindowCeiling,
  )
  const defaultBlockingLimit =
    actualContextWindow - MANUAL_COMPACT_BUFFER_TOKENS

  // Allow override for testing
  const blockingLimitOverride = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
  const parsedOverride = blockingLimitOverride
    ? parseInt(blockingLimitOverride, 10)
    : NaN
  const blockingLimit =
    !isNaN(parsedOverride) && parsedOverride > 0
      ? parsedOverride
      : defaultBlockingLimit

  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  // Allow disabling just auto-compact (keeps manual /compact working)
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  // Check if user has disabled auto-compact in their settings
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}

export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  // Snip removes messages but the surviving assistant's usage still reflects
  // pre-snip context, so tokenCountWithEstimation can't see the savings.
  // Subtract the rough-delta that snip already computed.
  snipTokensFreed = 0,
  autoCompactWindowCeiling?: number,
): Promise<boolean> {
  // Recursion guards. session_memory and compact are forked agents that
  // would deadlock.
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  // marble_origami is the ctx-agent — if ITS context blows up and
  // autocompact fires, runPostCompactCleanup calls resetContextCollapse()
  // which destroys the MAIN thread's committed log (module-level state
  // shared across forks). Inside feature() so the string DCEs from
  // external builds (it's in excluded-strings.txt).
  if (feature('CONTEXT_COLLAPSE')) {
    if (querySource === 'marble_origami') {
      return false
    }
  }

  if (!isAutoCompactEnabled()) {
    return false
  }

  // Reactive-only mode: suppress proactive autocompact, let reactive compact
  // catch the API's prompt-too-long. feature() wrapper keeps the flag string
  // out of external builds (REACTIVE_COMPACT is ant-only).
  // Note: returning false here also means autoCompactIfNeeded never reaches
  // trySessionMemoryCompaction in the query loop — the /compact call site
  // still tries session memory first. Revisit if reactive-only graduates.
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      return false
    }
  }

  // Context-collapse mode: same suppression. Collapse IS the context
  // management system when it's on — the 90% commit / 95% blocking-spawn
  // flow owns the headroom problem. Autocompact firing at effective-13k
  // (~93% of effective) sits right between collapse's commit-start (90%)
  // and blocking (95%), so it would race collapse and usually win, nuking
  // granular context that collapse was about to save. Gating here rather
  // than in isAutoCompactEnabled() keeps reactiveCompact alive as the 413
  // fallback (it consults isAutoCompactEnabled directly) and leaves
  // sessionMemory + manual /compact working.
  //
  // Consult isContextCollapseEnabled (not the raw gate) so the
  // CLAUDE_CONTEXT_COLLAPSE env override is honored here too. require()
  // inside the block breaks the init-time cycle (this file exports
  // getEffectiveContextWindowSize which collapse's index imports).
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      return false
    }
  }

  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model, autoCompactWindowCeiling)
  const effectiveWindow = getEffectiveContextWindowSize(
    model,
    autoCompactWindowCeiling,
  )

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow}${snipTokensFreed > 0 ? ` snipFreed=${snipTokensFreed}` : ''}`,
  )

  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
    tokenCount,
    model,
    autoCompactWindowCeiling,
  )

  return isAboveAutoCompactThreshold
}

/**
 * Official 2.1.301 (Sqr): after switching to a model with a smaller context
 * window, a conversation already too long for it is summarized by the model
 * that answered last, provided that model has the larger window and is still
 * allowed.
 */
export function getLargerContextSummaryModel(
  messages: Message[],
  model: string,
  autoCompactWindowCeiling?: number,
  snipTokensFreed = 0,
): string | undefined {
  const lastAssistant = messages.findLast(
    message => message.type === 'assistant' && !message.isApiErrorMessage,
  )
  const previousModel =
    lastAssistant?.type === 'assistant'
      ? lastAssistant.requestedModel
      : undefined
  if (typeof previousModel !== 'string' || previousModel === model) {
    return undefined
  }
  const betas = getSdkBetas()
  if (
    getContextWindowForModel(previousModel, betas) <=
    getContextWindowForModel(model, betas)
  ) {
    return undefined
  }
  const { isAtBlockingLimit } = calculateTokenWarningState(
    tokenCountWithEstimation(messages) - snipTokensFreed,
    model,
    autoCompactWindowCeiling,
  )
  if (!isAtBlockingLimit || !isModelAllowed(previousModel)) return undefined
  return previousModel
}

export type AutoCompactFailure = {
  message: string
}

export type AutoCompactResult = {
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
  compactionFailure?: AutoCompactFailure
  skip?: string
}

export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
  canUseTool: CanUseToolFn = hasPermissionsToUseTool,
): Promise<AutoCompactResult> {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  // Circuit breaker: stop retrying after N consecutive failures.
  // Without this, sessions where context is irrecoverably over the limit
  // hammer the API with doomed compaction attempts on every turn.
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  // Auto mode's classifier overflowed on this transcript: compact even below
  // the usual threshold so the denied tool calls can be reviewed again.
  const classifierOverflow = takeClassifierOverflowCompaction(
    toolUseContext.agentId,
  )
  const model = toolUseContext.options.mainLoopModel
  const autoCompactWindowCeiling = toolUseContext.options.autoCompactWindow
  const shouldCompact =
    classifierOverflow !== undefined ||
    (await shouldAutoCompact(
      messages,
      model,
      querySource,
      snipTokensFreed,
      autoCompactWindowCeiling,
    ))

  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(
      model,
      autoCompactWindowCeiling,
    ),
    querySource,
  }

  const summaryModel =
    (tracking?.consecutiveFailures ?? 0) > 0
      ? undefined
      : getLargerContextSummaryModel(
          messages,
          model,
          autoCompactWindowCeiling,
          snipTokensFreed,
        )

  const runCompaction = (context: ToolUseContext) =>
    runModSessionCompact(
      context,
      'auto',
      messages,
      undefined,
      async (compactMessages, instructions, compactContext) => {
        const compactParams = {
          ...cacheSafeParams,
          toolUseContext: compactContext,
          forkContextMessages: compactMessages,
        }
        const compactMode = getCompactMode()
        if (compactMode === 'claude' && !instructions) {
          const sessionMemoryResult = await trySessionMemoryCompaction(
            compactMessages,
            compactContext.agentId,
            recompactionInfo.autoCompactThreshold,
          )
          if (sessionMemoryResult) {
            if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
              notifyCompaction(
                querySource ?? 'compact',
                compactContext.agentId,
              )
            }
            markPostCompaction()
            return sessionMemoryResult
          }
        }

        logForDebugging(`autocompact: running ${compactMode}-style compact`)
        return compactMode === 'codex'
          ? compactConversationCodexStyle(
              compactMessages,
              compactContext,
              compactParams,
              true,
              instructions,
              true,
              getCodexCompactOptions(),
            )
          : compactConversation(
              compactMessages,
              compactContext,
              compactParams,
              true,
              instructions,
              true,
              recompactionInfo,
            )
      },
      canUseTool,
    )

  try {
    let outcome: Awaited<ReturnType<typeof runCompaction>> | undefined
    if (summaryModel !== undefined) {
      try {
        outcome = await runCompaction({
          ...toolUseContext,
          options: { ...toolUseContext.options, mainLoopModel: summaryModel },
        })
      } catch (error) {
        if (toolUseContext.abortController.signal.aborted) throw error
        logForDebugging(
          `autocompact: summary by ${summaryModel} failed (${errorMessage(error)}); retrying with ${model}`,
          { level: 'warn' },
        )
      }
    }
    outcome ??= await runCompaction(toolUseContext)
    if (outcome.skip !== undefined) {
      return { wasCompacted: false, skip: outcome.skip }
    }
    const compactionResult = outcome.compactionResult
    if (classifierOverflow && compactionResult) {
      logForDebugging(
        'autocompact: compacted after auto mode classifier transcript overflow',
      )
      compactionResult.attachments = [
        ...compactionResult.attachments,
        createAttachmentMessage({
          type: 'critical_system_reminder',
          content: classifierOverflowReminder(
            classifierOverflow.deniedToolNames,
          ),
        }),
      ]
    }

    // Reset lastSummarizedMessageId since legacy compaction replaces all messages
    // and the old message UUID will no longer exist in the new messages array
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      wasCompacted: true,
      compactionResult,
      // Reset failure count on success
      consecutiveFailures: 0,
    }
  } catch (error) {
    const isUserAbort =
      toolUseContext.abortController.signal.aborted ||
      hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)
    if (!isUserAbort && !(error instanceof CompactionBlockedError)) {
      logError(error)
    }
    // Increment consecutive failure count for circuit breaker.
    // The caller threads this through autoCompactTracking so the
    // next query loop iteration can skip futile retry attempts.
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures — skipping future attempts this session`,
        { level: 'warn' },
      )
    }
    return {
      wasCompacted: false,
      consecutiveFailures: nextFailures,
      ...(isUserAbort
        ? {}
        : { compactionFailure: { message: errorMessage(error) } }),
    }
  }
}
