import * as React from 'react'
import { useEffect, useState } from 'react'
import { extraUsage as extraUsageCommand } from 'src/commands/extra-usage/index.js'
import { formatCost } from 'src/cost-tracker.js'
import { getSubscriptionType } from 'src/utils/auth.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import type { DOMElement } from '../../ink/dom.js'
import { Box, Text, useStdin } from '../../ink.js'
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import type { InputEvent } from '../../ink/events/input-event.js'
import { useOptionalKeybindingContext } from '../../keybindings/KeybindingContext.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  consumeRateLimitResetCredit,
  type ExtraUsage,
  fetchUtilization,
  fetchRateLimitResetCredits,
  type OpenAIAccount,
  type RateLimit,
  type RateLimitResetCreditsDetails,
  type Utilization,
} from '../../services/api/usage.js'
import { formatResetText } from '../../utils/format.js'
import { logError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Byline } from '../design-system/Byline.js'
import { ProgressBar } from '../design-system/ProgressBar.js'
import {
  isEligibleForOverageCreditGrant,
  OverageCreditUpsell,
} from '../LogoV2/OverageCreditUpsell.js'

type LimitBarProps = {
  title: string
  limit: RateLimit
  maxWidth: number
  showTimeInReset?: boolean
  extraSubtext?: string
}

export function formatOpenAIAccountLine(account?: OpenAIAccount | null): string | null {
  if (!account?.name && !account?.email) return null
  if (account.name && account.email) {
    return `Openai Account Name: ${account.name} (${account.email})`
  }
  return `Openai Account Name: ${account.name ?? account.email}`
}

export function formatUsageLoadError(err: unknown): string {
  const axiosError = err as {
    message?: string
    response?: { status?: number; statusText?: string; data?: unknown }
  }
  const status = axiosError.response?.status
  const statusText = axiosError.response?.statusText
  const responseBody = axiosError.response?.data
    ? jsonStringify(axiosError.response.data)
    : undefined
  const details = [
    status ? `HTTP ${status}${statusText ? ` ${statusText}` : ''}` : undefined,
    responseBody,
    !status && axiosError.message ? axiosError.message : undefined,
  ]
    .filter(Boolean)
    .join(' ')

  return details ? `Failed to load usage data: ${details}` : 'Failed to load usage data'
}

function LimitBar({
  title,
  limit,
  maxWidth,
  showTimeInReset = true,
  extraSubtext,
}: LimitBarProps): React.ReactNode {
  const { utilization, resets_at } = limit
  if (utilization === null) {
    return null
  }

  // Calculate usage percentage
  const usedText = `${Math.floor(utilization)}% used`

  let subtext: string | undefined
  if (resets_at) {
    subtext = `Resets ${formatResetText(resets_at, true, showTimeInReset)}`
  }

  if (extraSubtext) {
    if (subtext) {
      subtext = `${extraSubtext} · ${subtext}`
    } else {
      subtext = extraSubtext
    }
  }

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Box columnGap={1}>
        <ProgressBar
          ratio={utilization / 100}
          width={Math.max(1, Math.min(50, maxWidth - usedText.length - 1))}
          fillColor="rate_limit_fill"
          emptyColor="rate_limit_empty"
        />
        <Text bold color="permission">{usedText}</Text>
      </Box>
      {subtext && <Text dimColor>{subtext}</Text>}
    </Box>
  )
}

export function Usage({
  contentHeight,
  onOwnsEscChange,
}: {
  contentHeight?: number
  onOwnsEscChange?: (ownsEsc: boolean) => void
} = {}): React.ReactNode {
  const scrollRef = React.useRef<ScrollBoxHandle>(null)
  const selectedCreditRef = React.useRef<DOMElement>(null)
  const { internal_eventEmitter } = useStdin()
  const keybindings = useOptionalKeybindingContext()
  const [utilization, setUtilization] = useState<Utilization | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [selectedCreditId, setSelectedCreditId] = useState<string | null>(null)
  const [isConfirmingReset, setIsConfirmingReset] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [resetMessage, setResetMessage] = useState<string | null>(null)
  const [resetDetails, setResetDetails] = useState<RateLimitResetCreditsDetails | null>(null)
  const [resetDetailsError, setResetDetailsError] = useState<string | null>(null)
  const isResettingRef = React.useRef(false)
  const { columns } = useModalOrTerminalSize(useTerminalSize())
  const splitColumns = utilization?.source === 'chatgpt' && columns >= 100
  const availableWidth = Math.max(1, columns - 6)
  const maxWidth = splitColumns
    ? Math.max(1, Math.floor((availableWidth - 3) / 2) - 4)
    : Math.min(availableWidth, 80)

  useEffect(() => {
    onOwnsEscChange?.(isConfirmingReset)
    return () => onOwnsEscChange?.(false)
  }, [isConfirmingReset, onOwnsEscChange])

  React.useLayoutEffect(() => {
    const viewport = scrollRef.current
    const element = selectedCreditRef.current
    if (!viewport || !element) return
    // Credit cards are nested in the right column; sum relative Yoga offsets.
    let top = 0
    let node: DOMElement | undefined = element
    while (node && node !== viewport.getElement()) {
      top += node.yogaNode?.getComputedTop() ?? 0
      node = node.parentNode
    }
    const bottom = top + (element.yogaNode?.getComputedHeight() ?? 0)
    const scrollTop = viewport.getScrollTop()
    if (top < scrollTop) viewport.scrollTo(top)
    else if (bottom > scrollTop + viewport.getViewportHeight()) {
      viewport.scrollTo(Math.max(top, bottom - viewport.getViewportHeight()))
    }
  }, [selectedCreditId, isConfirmingReset, columns, contentHeight])

  // The transcript's scroll listener mounts first; this viewport must own
  // scroll input while Usage is open, without changing other Settings tabs.
  useEffect(() => {
    if (contentHeight === undefined || !keybindings) return
    const scroll = (event: InputEvent) => {
      const viewport = scrollRef.current
      if (!viewport) return
      const result = keybindings.resolve(event.input, event.key, ['Scroll', 'Global'])
      if (result.type !== 'match') return
      const page = Math.max(1, viewport.getViewportHeight() - 1)
      switch (result.action) {
        case 'scroll:pageUp': viewport.scrollBy(-page); break
        case 'scroll:pageDown': viewport.scrollBy(page); break
        case 'scroll:lineUp': viewport.scrollBy(-1); break
        case 'scroll:lineDown': viewport.scrollBy(1); break
        case 'scroll:top': viewport.scrollTo(0); break
        case 'scroll:bottom': viewport.scrollToBottom(); break
        default: return
      }
      event.stopImmediatePropagation()
    }
    internal_eventEmitter?.prependListener('input', scroll)
    return () => { internal_eventEmitter?.removeListener('input', scroll) }
  }, [contentHeight, internal_eventEmitter, keybindings])

  const loadUtilization = React.useCallback(async () => {
    setIsLoading(true)
    setError(null)
    setResetDetails(null)
    setResetDetailsError(null)
    try {
      const data = await fetchUtilization()
      setUtilization(data)
      setSelectedCreditId(null)
      setIsConfirmingReset(false)
      if (data?.source === 'chatgpt') {
        try {
          const details = await fetchRateLimitResetCredits()
          setResetDetails(details)
          if (!details) setResetDetailsError('Reset details unavailable.')
        } catch (err) {
          logError(err as Error)
          setResetDetailsError(`Reset details unavailable. ${formatUsageLoadError(err)}`)
        }
      }
    } catch (err) {
      logError(err as Error)
      setError(formatUsageLoadError(err))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadUtilization()
  }, [loadUtilization])

  const resetCount = resetDetails?.available_count ?? utilization?.rate_limit_reset_credits?.available_count ?? 0
  const availableCredits = (resetDetails?.credits ?? [])
    .filter(credit => credit.status === 'available')
    .sort((a, b) => {
      const aTime = Date.parse(a.expires_at ?? '')
      const bTime = Date.parse(b.expires_at ?? '')
      return (Number.isNaN(aTime) ? Infinity : aTime) -
        (Number.isNaN(bTime) ? Infinity : bTime)
    })
  const selectedCredit = availableCredits.find(credit => credit.id === selectedCreditId)
  const canReset = utilization?.source === 'chatgpt' && resetCount > 0 &&
    availableCredits.length > 0 && !isLoading && !isResetting

  useKeybinding(
    'settings:retry',
    () => {
      void loadUtilization()
    },
    { context: 'Settings', isActive: !!(error || resetDetailsError) && !isLoading && !isResetting },
  )

  useKeybinding(
    'select:next',
    () => {
      if (!canReset || isConfirmingReset) return false
      const index = availableCredits.findIndex(credit => credit.id === selectedCreditId)
      setSelectedCreditId(availableCredits[Math.min(index + 1, availableCredits.length - 1)]!.id)
    },
    { context: 'Settings', isActive: canReset && !isConfirmingReset },
  )

  useKeybinding(
    'select:previous',
    () => {
      if (!canReset || isConfirmingReset) return false
      const index = availableCredits.findIndex(credit => credit.id === selectedCreditId)
      setSelectedCreditId(index > 0 ? availableCredits[index - 1]!.id : null)
    },
    { context: 'Settings', isActive: canReset && !!selectedCredit && !isConfirmingReset },
  )

  useKeybinding(
    'settings:close',
    () => {
      if (!canReset || !selectedCredit || isConfirmingReset) return false
      setIsConfirmingReset(true)
    },
    {
      context: 'Settings',
      isActive: canReset && !!selectedCredit && !isConfirmingReset,
    },
  )

  useKeybinding(
    'confirm:yes',
    () => {
      if (!canReset || !selectedCredit || !isConfirmingReset || isResettingRef.current) return false
      isResettingRef.current = true
      setIsResetting(true)
      setResetMessage(null)
      void consumeRateLimitResetCredit(selectedCredit.id)
        .then(async result => {
          switch (result?.code) {
            case 'reset':
            case 'already_redeemed':
              await loadUtilization()
              setResetMessage('Usage reset.')
              break
            case 'nothing_to_reset':
              await loadUtilization()
              setResetMessage('Your usage does not need a reset right now.')
              break
            case 'no_credit':
              await loadUtilization()
              setResetMessage('No usage limit resets are available.')
              break
            default:
              setResetMessage('Could not reset usage.')
          }
        })
        .catch(err => {
          logError(err as Error)
          setError(formatUsageLoadError(err))
        })
        .finally(() => {
          isResettingRef.current = false
          setIsResetting(false)
          setIsConfirmingReset(false)
        })
    },
    { context: 'Confirmation', isActive: canReset && !!selectedCredit && isConfirmingReset },
  )

  useKeybinding(
    'confirm:no',
    () => {
      if (!isConfirmingReset) return false
      setIsConfirmingReset(false)
    },
    { context: 'Confirmation', isActive: isConfirmingReset },
  )

  if (error) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error">Error: {error}</Text>
        <Text dimColor>
          <Byline>
            <ConfigurableShortcutHint
              action="settings:retry"
              context="Settings"
              fallback="r"
              description="retry"
            />
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Settings"
              fallback="Esc"
              description="cancel"
            />
          </Byline>
        </Text>
      </Box>
    )
  }

  if (!utilization) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          {isLoading
            ? 'Loading usage data…'
            : 'Usage data is unavailable for the current OpenAI authentication.'}
        </Text>
        <Text dimColor>
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Settings"
            fallback="Esc"
            description="cancel"
          />
        </Text>
      </Box>
    )
  }

  // Only Max and Team plans have a Sonnet limit that differs from the weekly
  // limit (see rateLimitMessages.ts). For other plans the bar is redundant.
  // Show for null (unknown plan) to stay consistent with rateLimitMessages.ts,
  // which labels it "Sonnet limit" in that case.
  const subscriptionType = getSubscriptionType()
  const showSonnetBar =
    subscriptionType === 'max' ||
    subscriptionType === 'team' ||
    subscriptionType === null

  const limits: Array<{
    title: string
    limit?: RateLimit | null
    extraSubtext?: string
  }> = utilization.source === 'chatgpt'
    ? (utilization.chatgpt_limits ?? [])
    : [
        {
          title: 'Current session',
          limit: utilization.five_hour,
        },
        {
          title: 'Current week (all models)',
          limit: utilization.seven_day,
        },
        ...(showSonnetBar
          ? [
              {
                title: 'Current week (Sonnet only)',
                limit: utilization.seven_day_sonnet,
              },
            ]
          : []),
      ]
  const accountLine = formatOpenAIAccountLine(utilization.openai_account)

  const usageDetails = (
    <Box flexDirection="column" gap={1} width="100%">
      <Text bold color="permission">Usage details</Text>
      {accountLine && <Text dimColor>{accountLine}</Text>}

      {limits.some(({ limit }) => typeof limit?.utilization === 'number') || (
        <Text dimColor>/usage is only available for subscription plans.</Text>
      )}

      {limits.map(
        ({ title, limit, extraSubtext }) =>
          limit && (
            <LimitBar
              key={title}
              title={title}
              limit={limit}
              extraSubtext={extraSubtext}
              maxWidth={maxWidth}
            />
          ),
      )}

      {utilization.extra_usage && (
        <ExtraUsageSection
          extraUsage={utilization.extra_usage}
          maxWidth={maxWidth}
        />
      )}

      {isEligibleForOverageCreditGrant() && (
        <OverageCreditUpsell maxWidth={maxWidth} />
      )}
    </Box>
  )

  const content = (
    <Box flexDirection={splitColumns ? 'row' : 'column'} gap={2} width="100%" alignItems="flex-start">
      <Box flexDirection="column" width={splitColumns ? '50%' : '100%'} flexShrink={1} paddingRight={splitColumns ? 1 : 0}>
        {usageDetails}
      </Box>
      {utilization.source === 'chatgpt' && (
        <Box
          flexDirection="column"
          width={splitColumns ? '50%' : '100%'}
          flexShrink={1}
          gap={1}
          borderStyle="single"
          borderColor="promptBorder"
          borderTop={!splitColumns}
          borderBottom={false}
          borderLeft={splitColumns}
          borderRight={false}
          paddingLeft={splitColumns ? 2 : 0}
          paddingTop={splitColumns ? 0 : 1}
        >
          <Box justifyContent="space-between">
            <Text bold color="permission">Reset credits</Text>
            <Text bold>{resetCount} available</Text>
          </Box>
          {resetMessage && <Text color="success">{resetMessage}</Text>}
          {isLoading && <Text dimColor>Loading reset details…</Text>}
          {resetDetailsError && (
            <Box flexDirection="column">
              <Text color="warning">{resetDetailsError}</Text>
              <Text dimColor>
                <ConfigurableShortcutHint action="settings:retry" context="Settings" fallback="r" description="retry" />
              </Text>
            </Box>
          )}
          {resetDetails && availableCredits.length === 0 && (
            <Text dimColor>No available reset credits returned.</Text>
          )}
          {availableCredits.map((credit, index) => {
            const isSelected = credit.id === selectedCreditId
            return (
              <Box
                key={credit.id}
                ref={isSelected ? selectedCreditRef : undefined}
                flexDirection="column"
                borderStyle="round"
                borderColor={isSelected ? 'permission' : 'promptBorder'}
                paddingX={1}
              >
                <Text bold color={isSelected ? 'permission' : undefined}>
                  {isSelected ? '› ' : ''}{index + 1}. {credit.title || 'Usage limit reset'}
                </Text>
                <Text dimColor>Granted: {formatCreditTime(credit.granted_at)}</Text>
                <Text dimColor>
                  Expires: {credit.expires_at === null ? 'Does not expire' : formatCreditTime(credit.expires_at)}
                </Text>
                {isSelected && !isConfirmingReset && !isResetting && (
                  <Text color="permission">
                    <ConfigurableShortcutHint action="settings:close" context="Settings" fallback="Enter" description="use this reset" />
                  </Text>
                )}
                {isSelected && isConfirmingReset && (
                  <Box flexDirection="column" marginTop={1}>
                    <Text bold color="warning">Use this reset?</Text>
                    <Text>Card: {credit.title || 'Usage limit reset'}</Text>
                    <Text dimColor>ID: {credit.id}</Text>
                    <Text color="warning">This consumes one credit.</Text>
                    <Text>
                      <ConfigurableShortcutHint action="confirm:yes" context="Confirmation" fallback="Enter" description="confirm" />
                      {' · '}
                      <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />
                    </Text>
                  </Box>
                )}
                {isSelected && isResetting && <Text color="warning">Resetting usage…</Text>}
              </Box>
            )
          })}
          {resetDetails && resetCount > availableCredits.length && (
            <Text dimColor>Showing {availableCredits.length} of {resetCount} available credits.</Text>
          )}
        </Box>
      )}
    </Box>
  )
  const footer = (
    <Text dimColor>
      {canReset && !isConfirmingReset && (
        <>
          <ConfigurableShortcutHint action="select:next" context="Settings" fallback="↓" description="select reset" />
          {' · '}
          <ConfigurableShortcutHint action="select:previous" context="Settings" fallback="↑" description="previous" />
          {' · '}
        </>
      )}
      {contentHeight !== undefined && (
        <>
          <ConfigurableShortcutHint action="scroll:pageDown" context="Scroll" fallback="PgDn" description="scroll" />
          {' · '}
        </>
      )}
      <ConfigurableShortcutHint action="confirm:no" context={isConfirmingReset ? 'Confirmation' : 'Settings'} fallback="Esc" description={isConfirmingReset ? 'back' : 'close'} />
    </Text>
  )

  if (contentHeight === undefined) return <Box flexDirection="column" width="100%" gap={1}>{content}{footer}</Box>
  return (
    <Box flexDirection="column" width="100%" height={contentHeight} flexShrink={0}>
      {/* Start loaded content at the top instead of following the loading view's bottom. */}
      <ScrollBox key={isLoading ? 'loading' : 'loaded'} ref={scrollRef} flexDirection="column" height={Math.max(1, contentHeight - 1)} flexShrink={0}>
        {content}
      </ScrollBox>
      {footer}
    </Box>
  )
}

function formatCreditTime(value?: string | null): string {
  if (!value) return 'Unavailable'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unavailable'
  return date.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZoneName: 'short',
  })
}

type ExtraUsageSectionProps = {
  extraUsage: ExtraUsage
  maxWidth: number
}

const EXTRA_USAGE_SECTION_TITLE = 'Extra usage'

function ExtraUsageSection({
  extraUsage,
  maxWidth,
}: ExtraUsageSectionProps): React.ReactNode {
  const subscriptionType = getSubscriptionType()
  const isProOrMax = subscriptionType === 'pro' || subscriptionType === 'max'
  if (!isProOrMax) {
    // Only show to Pro and Max, consistent with claude.ai non-admin usage settings
    return false
  }

  if (!extraUsage.is_enabled) {
    if (extraUsageCommand.isEnabled()) {
      return (
        <Box flexDirection="column">
          <Text bold>{EXTRA_USAGE_SECTION_TITLE}</Text>
          <Text dimColor>Extra usage not enabled · /extra-usage to enable</Text>
        </Box>
      )
    }

    return null
  }

  if (extraUsage.monthly_limit === null) {
    return (
      <Box flexDirection="column">
        <Text bold>{EXTRA_USAGE_SECTION_TITLE}</Text>
        <Text dimColor>Unlimited</Text>
      </Box>
    )
  }

  if (
    typeof extraUsage.used_credits !== 'number' ||
    typeof extraUsage.utilization !== 'number'
  ) {
    return null
  }

  const formattedUsedCredits = formatCost(extraUsage.used_credits / 100, 2)
  const formattedMonthlyLimit = formatCost(extraUsage.monthly_limit / 100, 2)
  const now = new Date()
  const oneMonthReset = new Date(now.getFullYear(), now.getMonth() + 1, 1)

  return (
    <LimitBar
      title={EXTRA_USAGE_SECTION_TITLE}
      limit={{
        utilization: extraUsage.utilization,
        // Not applicable for enterprises, but for now we don't render this for them
        resets_at: oneMonthReset.toISOString(),
      }}
      showTimeInReset={false}
      extraSubtext={`${formattedUsedCredits} / ${formattedMonthlyLimit} spent`}
      maxWidth={maxWidth}
    />
  )
}
