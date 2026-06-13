import figures from 'figures'
import * as React from 'react'
import { useMemo, useRef } from 'react'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text, useAnimationFrame } from '../../ink.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import type { Theme } from '../../utils/theme.js'
import { buildSpinnerAnimationLine } from './spinnerAnimationLine.js'
import { SpinnerGlyph } from './SpinnerGlyph.js'
import type { SpinnerMode } from './types.js'
import { useStalledAnimation } from './useStalledAnimation.js'

const SEP_WIDTH = stringWidth(' · ')
const THINKING_BARE_WIDTH = stringWidth('thinking')
const SHOW_TOKENS_AFTER_MS = 30_000

export type SpinnerAnimationRowProps = {
  // Animation inputs
  mode: SpinnerMode
  reducedMotion: boolean
  hasActiveTools: boolean
  responseLengthRef: React.RefObject<number>

  // Message (stable within a turn)
  message: string
  messageColor: keyof Theme
  shimmerColor: keyof Theme
  overrideColor?: keyof Theme | null

  // Timer refs (stable references)
  loadingStartTimeRef: React.RefObject<number>
  totalPausedMsRef: React.RefObject<number>
  pauseStartTimeRef: React.RefObject<number | null>

  // Display flags
  spinnerSuffix?: string | null
  verbose: boolean
  columns: number

  // Teammate-derived (computed by parent from tasks)
  hasRunningTeammates: boolean
  teammateTokens: number
  foregroundedTeammate: InProcessTeammateTaskState | undefined
  /** Leader's turn has completed. Suppresses stall-red since responseLengthRef/hasActiveTools track leader state only. */
  leaderIsIdle?: boolean

  // Thinking (state owned by parent, mode-dependent)
  thinkingStatus: 'thinking' | number | null
  effortSuffix: string

}

/**
 * The 50ms-animated portion of SpinnerWithVerb. Owns useAnimationFrame(50)
 * and all values derived from the animation clock (frame, glimmer, token
 * counter animation, elapsed-time, stalled intensity, thinking shimmer).
 *
 * The parent SpinnerWithVerb is freed from the 50ms render loop and only
 * re-renders when its props/app state change (~25x/turn instead of ~383x).
 * That keeps the outer Box shells, useAppState selectors, task filtering,
 * and tip/tree subtrees out of the hot animation path.
 */
export function SpinnerAnimationRow({
  mode,
  reducedMotion,
  hasActiveTools,
  responseLengthRef,
  message,
  messageColor,
  overrideColor,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  spinnerSuffix,
  verbose,
  columns,
  hasRunningTeammates,
  teammateTokens,
  foregroundedTeammate,
  leaderIsIdle = false,
  thinkingStatus,
  effortSuffix,
}: SpinnerAnimationRowProps): React.ReactNode {
  const [viewportRef, time] = useAnimationFrame(reducedMotion ? null : 50)

  // === Elapsed time (wall-clock, derived from refs each frame) ===
  const now = Date.now()
  const elapsedTimeMs =
    pauseStartTimeRef.current !== null
      ? pauseStartTimeRef.current -
        loadingStartTimeRef.current -
        totalPausedMsRef.current
      : now - loadingStartTimeRef.current - totalPausedMsRef.current

  // Track wall-clock turn start for teammates. While a swarm is running the
  // leader's elapsedTimeMs may jump around (new API calls reset
  // loadingStartTimeRef; pauses freeze it), so we anchor to the earliest
  // derived start seen so far. When no teammates are running this just tracks
  // derivedStart every frame, effectively resetting for the next swarm.
  const derivedStart = now - elapsedTimeMs
  const turnStartRef = useRef(derivedStart)
  if (!hasRunningTeammates || derivedStart < turnStartRef.current) {
    turnStartRef.current = derivedStart
  }

  // === Animation derivations from `time` ===
  const currentResponseLength = responseLengthRef.current

  // Suppress stall detection when leader is idle — responseLengthRef and
  // hasActiveTools both track leader state. When viewing an active teammate
  // while leader is idle, they'd otherwise flag a false stall after 3s.
  // Treating leaderIsIdle like hasActiveTools resets the stall timer.
  const { isStalled, stalledIntensity } = useStalledAnimation(
    time,
    currentResponseLength,
    hasActiveTools || leaderIsIdle,
    reducedMotion,
  )

  const frame = reducedMotion ? 0 : Math.floor(time / 120)

  // message is stable within a turn; stringWidth is expensive enough (Bun native
  // call per code point) to memoize explicitly across the 50ms loop.
  const glimmerMessageWidth = useMemo(() => stringWidth(message), [message])

  // === Token counter animation (smooth increment, driven by 50ms clock) ===
  const tokenCounterRef = useRef(currentResponseLength)
  if (reducedMotion) {
    tokenCounterRef.current = currentResponseLength
  } else {
    const gap = currentResponseLength - tokenCounterRef.current
    if (gap > 0) {
      let increment
      if (gap < 70) {
        increment = 3
      } else if (gap < 200) {
        increment = Math.max(8, Math.ceil(gap * 0.15))
      } else {
        increment = 50
      }
      tokenCounterRef.current = Math.min(
        tokenCounterRef.current + increment,
        currentResponseLength,
      )
    }
  }
  const displayedResponseLength = tokenCounterRef.current
  const leaderTokens = Math.round(displayedResponseLength / 4)

  const effectiveElapsedMs = hasRunningTeammates
    ? Math.max(elapsedTimeMs, now - turnStartRef.current)
    : elapsedTimeMs
  const timerText = formatDuration(effectiveElapsedMs)
  const timerWidth = stringWidth(timerText)

  // === Token count (leader + teammates, or foregrounded teammate) ===
  const totalTokens =
    foregroundedTeammate && !foregroundedTeammate.isIdle
      ? (foregroundedTeammate.progress?.tokenCount ?? 0)
      : leaderTokens + teammateTokens
  const tokenCount = formatNumber(totalTokens)
  const tokensText = hasRunningTeammates
    ? `${tokenCount} tokens`
    : `${figures.arrowDown} ${tokenCount} tokens`
  const tokensWidth = stringWidth(tokensText)

  // === Thinking text (may shrink to fit) ===
  let thinkingText =
    thinkingStatus === 'thinking'
      ? `thinking${effortSuffix}`
      : typeof thinkingStatus === 'number'
        ? `thought for ${Math.max(1, Math.round(thinkingStatus / 1000))}s`
        : null
  let thinkingWidthValue = thinkingText ? stringWidth(thinkingText) : 0

  // === Progressive width gating ===
  const messageWidth = glimmerMessageWidth + 2
  const sep = SEP_WIDTH

  const wantsThinking = thinkingStatus !== null
  const wantsTimerAndTokens =
    verbose || hasRunningTeammates || effectiveElapsedMs > SHOW_TOKENS_AFTER_MS

  const availableSpace = columns - messageWidth - 5

  let showThinking = wantsThinking && availableSpace > thinkingWidthValue
  if (
    !showThinking &&
    wantsThinking &&
    thinkingStatus === 'thinking' &&
    effortSuffix
  ) {
    if (availableSpace > THINKING_BARE_WIDTH) {
      thinkingText = 'thinking'
      thinkingWidthValue = THINKING_BARE_WIDTH
      showThinking = true
    }
  }
  const usedAfterThinking = showThinking ? thinkingWidthValue + sep : 0

  const showTimer =
    wantsTimerAndTokens && availableSpace > usedAfterThinking + timerWidth
  const usedAfterTimer = usedAfterThinking + (showTimer ? timerWidth + sep : 0)

  const showTokens =
    wantsTimerAndTokens &&
    totalTokens > 0 &&
    availableSpace > usedAfterTimer + tokensWidth


  const thinkingOnly =
    showThinking &&
    thinkingStatus === 'thinking' &&
    !spinnerSuffix &&
    !showTimer &&
    !showTokens &&
    true

  // === Build status text ===
  const parts = [
    ...(spinnerSuffix ? [spinnerSuffix] : []),
    ...(showTimer ? [timerText] : []),
    ...(showTokens
      ? [`${!hasRunningTeammates ? `${mode === 'requesting' ? figures.arrowUp : figures.arrowDown} ` : ''}${tokenCount} tokens`]
      : []),
    ...(showThinking && thinkingText ? [thinkingText] : []),
  ]

  const statusText =
    foregroundedTeammate && !foregroundedTeammate.isIdle
      ? `(esc to interrupt ${foregroundedTeammate.identity.agentName})`
      : !foregroundedTeammate && parts.length > 0
        ? thinkingOnly
          ? `(${thinkingText})`
          : `(${parts.join(' · ')})`
        : ''
  const lineText = buildSpinnerAnimationLine({
    columns: Math.max(0, columns - 2),
    message,
    statusText,
  })
  const lineColor = isStalled ? 'error' : messageColor

  return (
    <Box
      ref={viewportRef}
      flexDirection="row"
      flexWrap="nowrap"
      height={1}
      overflow="hidden"
      marginTop={1}
      width="100%"
    >
      <SpinnerGlyph
        frame={frame}
        messageColor={messageColor}
        stalledIntensity={overrideColor ? 0 : stalledIntensity}
        reducedMotion={reducedMotion}
        time={time}
      />
      <Text color={overrideColor ?? lineColor}>{lineText}</Text>
    </Box>
  )
}
