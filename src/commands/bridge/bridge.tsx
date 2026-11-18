import { feature } from 'bun:bundle'
import { toString as qrToString } from 'qrcode'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { getBridgeAccessToken } from '../../bridge/bridgeConfig.js'
import {
  checkBridgeMinVersion,
  getBridgeDisabledReason,
  isEnvLessBridgeEnabled,
} from '../../bridge/bridgeEnabled.js'
import {
  BRIDGE_FAILED_NOTIFICATION_KEY,
  BRIDGE_LOGIN_DETAIL,
  bridgeFailedDialogHint,
} from '../../bridge/bridgeFailure.js'
import { getBridgeStatus } from '../../bridge/bridgeStatusUtil.js'
import { checkEnvLessBridgeMinVersion } from '../../bridge/envLessBridgeConfig.js'
import {
  BRIDGE_LOGIN_INSTRUCTION,
  REMOTE_CONTROL_DISCONNECTED_MSG,
} from '../../bridge/types.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { ListItem } from '../../components/design-system/ListItem.js'
import { shouldShowRemoteCallout } from '../../components/RemoteCallout.js'
import { BRIDGE_FAILED_INDICATOR } from '../../constants/figures.js'
import { useNotifications } from '../../context/notifications.js'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { codeModeRemoteControlRefusal } from '../../tools/REPLTool/codeModeGate.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { logForDebugging } from '../../utils/debug.js'

type Props = {
  onDone: LocalJSXCommandOnDone
  name?: string
}

/**
 * /remote-control command — manages the bidirectional bridge connection.
 *
 * When enabled, sets replBridgeEnabled in AppState, which triggers
 * useReplBridge in REPL.tsx to initialize the bridge connection.
 * The bridge registers an environment, creates a session with the current
 * conversation, polls for work, and connects an ingress WebSocket for
 * bidirectional messaging between the CLI and claude.ai.
 *
 * Running /remote-control when already connected shows a dialog with the session
 * URL and options to disconnect or continue.
 */
function BridgeToggle({ onDone, name }: Props): React.ReactNode {
  const setAppState = useSetAppState()
  const replBridgeConnected = useAppState(s => s.replBridgeConnected)
  const replBridgeEnabled = useAppState(s => s.replBridgeEnabled)
  const replBridgeOutboundOnly = useAppState(s => s.replBridgeOutboundOnly)
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: bridge starts once, should not restart on state changes
  useEffect(() => {
    // If already connected or enabled in full bidirectional mode, show
    // disconnect confirmation. Outbound-only (CCR mirror) doesn't count —
    // /remote-control upgrades it to full RC instead.
    if ((replBridgeConnected || replBridgeEnabled) && !replBridgeOutboundOnly) {
      setShowDisconnectDialog(true)
      return
    }

    let cancelled = false
    void (async () => {
      // Pre-flight checks before enabling (awaits GrowthBook init if disk
      // cache is stale — so Max users don't get a false "not enabled" error)
      const error = await checkBridgePrerequisites()
      if (cancelled) return
      if (error) {
        logEvent('tengu_bridge_command', {
          action:
            'preflight_failed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        onDone(error, { display: 'system' })
        return
      }

      // Show first-time remote dialog if not yet seen.
      // Store the name now so it's in AppState when the callout handler later
      // enables the bridge (the handler only sets replBridgeEnabled, not the name).
      if (shouldShowRemoteCallout()) {
        setAppState(prev => {
          if (prev.showRemoteCallout) return prev
          return {
            ...prev,
            showRemoteCallout: true,
            replBridgeInitialName: name,
          }
        })
        onDone('', { display: 'system' })
        return
      }

      // Enable the bridge — useReplBridge in REPL.tsx handles the rest:
      // registers environment, creates session with conversation, connects WebSocket
      logEvent('tengu_bridge_command', {
        action:
          'connect' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      setAppState(prev => {
        if (prev.replBridgeEnabled && !prev.replBridgeOutboundOnly) return prev
        return {
          ...prev,
          replBridgeEnabled: true,
          replBridgeExplicit: true,
          replBridgeOutboundOnly: false,
          replBridgeInitialName: name,
          replBridgeError: undefined,
          replBridgeErrorKind: undefined,
        }
      })
      onDone('Remote Control connecting\u2026', {
        display: 'system',
      })
    })()

    return () => {
      cancelled = true
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- run once on mount

  if (showDisconnectDialog) {
    return <BridgeDisconnectDialog onDone={onDone} />
  }

  return null
}

/**
 * Dialog shown when /remote-control is used while the bridge is connected or
 * enabled. Shows the session URL, or why Remote Control isn't connected, and
 * lets the user disconnect or continue.
 */
function BridgeDisconnectDialog({ onDone }: Props): React.ReactNode {
  useRegisterOverlay('bridge-disconnect-dialog')
  const setAppState = useSetAppState()
  const { removeNotification } = useNotifications()
  const sessionUrl = useAppState(s => s.replBridgeSessionUrl)
  const connectUrl = useAppState(s => s.replBridgeConnectUrl)
  const sessionActive = useAppState(s => s.replBridgeSessionActive)
  const connected = useAppState(s => s.replBridgeConnected)
  const reconnecting = useAppState(s => s.replBridgeReconnecting)
  const enabled = useAppState(s => s.replBridgeEnabled)
  const error = useAppState(s => s.replBridgeError)
  const errorKind = useAppState(s => s.replBridgeErrorKind)
  const [focusKey, setFocusKey] = useState<DialogItemKey>('continue')
  const [showQR, setShowQR] = useState(false)
  const [qrText, setQrText] = useState('')

  const live = connected && !reconnecting
  const [liveAtOpen] = useState(live)
  const failed = !live && Boolean(error)
  const notConnected = failed || (!connected && !enabled)
  const hint = failed && error ? bridgeFailedDialogHint(error, errorKind) : ''
  const displayUrl = sessionActive ? sessionUrl : connectUrl

  // Generate QR code when URL changes or QR is toggled on
  useEffect(() => {
    if (!showQR || !displayUrl) {
      setQrText('')
      return
    }
    qrToString(displayUrl, {
      type: 'utf8',
      errorCorrectionLevel: 'L',
      small: true,
    })
      .then(setQrText)
      .catch(() => setQrText(''))
  }, [showQR, displayUrl])

  function handleDisconnect(): void {
    removeNotification(BRIDGE_FAILED_NOTIFICATION_KEY)
    setAppState(prev => ({
      ...prev,
      replBridgeEnabled: false,
      replBridgeExplicit: false,
      replBridgeOutboundOnly: false,
      replBridgeError: undefined,
      replBridgeErrorKind: undefined,
    }))
    logEvent('tengu_bridge_command', {
      action:
        'disconnect' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    onDone(REMOTE_CONTROL_DISCONNECTED_MSG, { display: 'system' })
  }

  function handleShowQR(): void {
    if (live) setShowQR(prev => !prev)
  }

  function handleContinue(): void {
    onDone(undefined, { display: 'skip' })
  }

  // The QR row stays (as "unavailable") if the link dropped while open.
  const items: { key: DialogItemKey; label: string; run: () => void }[] = [
    { key: 'disconnect', label: 'Disconnect this session', run: handleDisconnect },
    ...(live || liveAtOpen
      ? [
          {
            key: 'qr' as const,
            label: !live
              ? 'QR code unavailable'
              : showQR
                ? 'Hide QR code'
                : 'Show QR code',
            run: handleShowQR,
          },
        ]
      : []),
    { key: 'continue', label: 'Continue', run: handleContinue },
  ]
  const focusIndex = Math.max(
    0,
    items.findIndex(item => item.key === focusKey),
  )

  useKeybindings(
    {
      'select:next': () =>
        setFocusKey(items[(focusIndex + 1) % items.length]!.key),
      'select:previous': () =>
        setFocusKey(
          items[(focusIndex - 1 + items.length) % items.length]!.key,
        ),
      'select:accept': () => items[focusIndex]!.run(),
    },
    { context: 'Select' },
  )

  const qrLines =
    live && qrText ? qrText.split('\n').filter(l => l.length > 0) : []
  const { label: statusLabel, color: statusColor } = getBridgeStatus({
    error,
    connected,
    sessionActive,
    reconnecting,
  })

  return (
    <Dialog title="Remote Control" onCancel={handleContinue} hideInputGuide>
      <Box flexDirection="column" gap={1}>
        {live ? (
          <Text>
            This session is available via Remote Control
            {displayUrl ? ` at ${displayUrl}` : ''}.
          </Text>
        ) : (
          <Box flexDirection="column">
            <Text color={statusColor}>
              {notConnected
                ? `${BRIDGE_FAILED_INDICATOR} Remote Control isn't connected.`
                : statusLabel}
            </Text>
            {error && (
              <Text color="error">
                {error === BRIDGE_LOGIN_DETAIL
                  ? 'Remote Control needs a claude.ai sign-in.'
                  : error}
              </Text>
            )}
          </Box>
        )}
        {hint && <Text>{hint}</Text>}
        {showQR && qrLines.length > 0 && (
          <Box flexDirection="column">
            {qrLines.map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column">
          {items.map((item, i) => (
            <ListItem key={item.key} isFocused={focusIndex === i}>
              <Text>{item.label}</Text>
            </ListItem>
          ))}
        </Box>
        <Text dimColor>Enter to select · Esc to continue</Text>
      </Box>
    </Dialog>
  )
}

type DialogItemKey = 'disconnect' | 'qr' | 'continue'

/**
 * Check bridge prerequisites. Returns an error message if a precondition
 * fails, or null if all checks pass. Awaits GrowthBook init if the disk
 * cache is stale, so a user who just became entitled (e.g. upgraded to Max,
 * or the flag just launched) gets an accurate result on the first try.
 */
async function checkBridgePrerequisites(): Promise<string | null> {
  const codeModeRefusal = codeModeRemoteControlRefusal()
  if (codeModeRefusal) return codeModeRefusal

  // Check organization policy — remote control may be disabled
  const { waitForPolicyLimitsToLoad, isPolicyAllowed } = await import(
    '../../services/policyLimits/index.js'
  )
  await waitForPolicyLimitsToLoad()
  if (!isPolicyAllowed('allow_remote_control')) {
    return "Remote Control is disabled by your organization's policy."
  }

  const disabledReason = await getBridgeDisabledReason()
  if (disabledReason) {
    return disabledReason
  }

  // Mirror the v1/v2 branching logic in initReplBridge: env-less (v2) is used
  // only when the flag is on AND the session is not perpetual.  In assistant
  // mode (KAIROS) useReplBridge sets perpetual=true, which forces
  // initReplBridge onto the v1 path — so the prerequisite check must match.
  let useV2 = isEnvLessBridgeEnabled()
  if (feature('KAIROS') && useV2) {
    const { isAssistantMode } = await import('../../assistant/index.js')
    if (isAssistantMode()) {
      useV2 = false
    }
  }
  const versionError = useV2
    ? await checkEnvLessBridgeMinVersion()
    : checkBridgeMinVersion()
  if (versionError) {
    return versionError
  }

  if (!getBridgeAccessToken()) {
    return BRIDGE_LOGIN_INSTRUCTION
  }

  logForDebugging('[bridge] Prerequisites passed, enabling bridge')
  return null
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const name = args.trim() || undefined
  return <BridgeToggle onDone={onDone} name={name} />
}
