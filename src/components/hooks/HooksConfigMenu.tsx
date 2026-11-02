/**
 * HooksConfigMenu is a read-only browser for configured hooks.
 *
 * It opens on the configured hooks grouped by event; "All events" drills into
 * each hook event, its matchers and hooks (of any type: command, prompt,
 * agent, http), and any hook opens its read-only details. To add or modify
 * hooks, users should edit settings.json directly or ask Claude — the menu
 * directs them there.
 *
 * The menu is read-only because the old editing UI only supported
 * command-type hooks and duplicating the settings.json editing surface
 * in-menu for all four types would be a maintenance burden.
 */
import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { useAppState, useAppStateStore } from 'src/state/AppState.js'
import type { CommandResultDisplay } from '../../commands.js'
import { useSettingsChange } from '../../hooks/useSettingsChange.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  getHookEventMetadata,
  getHooksForMatcher,
  getMatcherMetadata,
  getSortedMatchersForEvent,
  groupHooksByEventAndMatcher,
} from '../../utils/hooks/hooksConfigManager.js'
import type { IndividualHookConfig } from '../../utils/hooks/hooksSettings.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from '../../utils/settings/settings.js'
import { plural } from '../../utils/stringUtils.js'
import { Dialog } from '../design-system/Dialog.js'
import { HooksListMode } from './HooksListMode.js'
import { SelectEventMode } from './SelectEventMode.js'
import { SelectHookMode } from './SelectHookMode.js'
import { SelectMatcherMode } from './SelectMatcherMode.js'
import { ViewHookMode } from './ViewHookMode.js'

type Props = {
  toolNames: string[]
  onExit: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

type ModeState =
  | { mode: 'list' }
  | { mode: 'select-event' }
  | { mode: 'select-matcher'; event: HookEvent }
  | { mode: 'select-hook'; event: HookEvent; matcher: string }
  | {
      mode: 'view-hook'
      event: HookEvent
      hook: IndividualHookConfig
      from: 'list' | 'select-hook'
    }

export function HooksConfigMenu({ toolNames, onExit }: Props): React.ReactNode {
  const [modeState, setModeState] = useState<ModeState>({ mode: 'list' })
  const [listFocusIndex, setListFocusIndex] = useState(0)
  // Cache whether hooks are disabled by policy settings.
  // getSettingsForSource() is expensive (file read + JSON parse + validation),
  // so we compute it once on mount and only re-compute when policy settings change.
  // Short-circuit evaluation ensures we skip the expensive check when hooks aren't disabled.
  const [disabledByPolicy, setDisabledByPolicy] = useState(() => {
    const settings = getSettings_DEPRECATED()
    const hooksDisabled = settings?.disableAllHooks === true
    return (
      hooksDisabled &&
      getSettingsForSource('policySettings')?.disableAllHooks === true
    )
  })

  // Check if hooks are restricted to managed-only by policy
  const [restrictedByPolicy, setRestrictedByPolicy] = useState(() => {
    return (
      getSettingsForSource('policySettings')?.allowManagedHooksOnly === true
    )
  })

  // Update cached values when policy settings change
  useSettingsChange(source => {
    if (source === 'policySettings') {
      const settings = getSettings_DEPRECATED()
      const hooksDisabled = settings?.disableAllHooks === true
      setDisabledByPolicy(
        hooksDisabled &&
          getSettingsForSource('policySettings')?.disableAllHooks === true,
      )
      setRestrictedByPolicy(
        getSettingsForSource('policySettings')?.allowManagedHooksOnly === true,
      )
    }
  })

  // Extract commonly used values from modeState for convenience
  const mode = modeState.mode
  const selectedEvent = 'event' in modeState ? modeState.event : 'PreToolUse'
  const selectedMatcher = 'matcher' in modeState ? modeState.matcher : null

  const mcp = useAppState(s => s.mcp)
  const appStateStore = useAppStateStore()
  const combinedToolNames = useMemo(
    () => [...toolNames, ...mcp.tools.map(tool => tool.name)],
    [toolNames, mcp.tools],
  )

  const hooksByEventAndMatcher = useMemo(
    () =>
      groupHooksByEventAndMatcher(appStateStore.getState(), combinedToolNames),
    [combinedToolNames, appStateStore],
  )

  const sortedMatchersForSelectedEvent = useMemo(
    () => getSortedMatchersForEvent(hooksByEventAndMatcher, selectedEvent),
    [hooksByEventAndMatcher, selectedEvent],
  )

  const hooksForSelectedMatcher = useMemo(
    () =>
      getHooksForMatcher(
        hooksByEventAndMatcher,
        selectedEvent,
        selectedMatcher,
      ),
    [hooksByEventAndMatcher, selectedEvent, selectedMatcher],
  )

  // Handler for exiting the dialog
  const handleExit = useCallback(() => {
    onExit('Hooks dialog dismissed', { display: 'system' })
  }, [onExit])

  // Escape handling for list mode - exit the menu
  useKeybinding('confirm:no', handleExit, {
    context: 'Confirmation',
    isActive: mode === 'list',
  })

  // Escape handling for select-event mode - back to the list
  useKeybinding(
    'confirm:no',
    () => {
      setModeState({ mode: 'list' })
    },
    {
      context: 'Confirmation',
      isActive: mode === 'select-event',
    },
  )

  // Escape handling for select-matcher mode - go to select-event
  useKeybinding(
    'confirm:no',
    () => {
      setModeState({ mode: 'select-event' })
    },
    {
      context: 'Confirmation',
      isActive: mode === 'select-matcher',
    },
  )

  // Escape handling for select-hook mode - go to select-matcher or select-event
  useKeybinding(
    'confirm:no',
    () => {
      if ('event' in modeState) {
        if (
          getMatcherMetadata(modeState.event, combinedToolNames) !== undefined
        ) {
          setModeState({ mode: 'select-matcher', event: modeState.event })
        } else {
          setModeState({ mode: 'select-event' })
        }
      }
    },
    {
      context: 'Confirmation',
      isActive: mode === 'select-hook',
    },
  )

  // Escape handling for view-hook mode - back to where it was opened from
  const closeViewHook = useCallback(() => {
    if (modeState.mode !== 'view-hook') return
    const { event, hook, from } = modeState
    if (from === 'list') {
      setModeState({ mode: 'list' })
      return
    }
    setModeState({
      mode: 'select-hook',
      event,
      matcher: hook.matcher || '',
    })
  }, [modeState])
  useKeybinding(
    'confirm:no',
    closeViewHook,
    {
      context: 'Confirmation',
      isActive: mode === 'view-hook',
    },
  )

  const hookEventMetadata = getHookEventMetadata(combinedToolNames)

  // Check if hooks are disabled
  const settings = getSettings_DEPRECATED()
  const hooksDisabled = settings?.disableAllHooks === true

  // Count hooks per event for the event-selection view, and the total.
  const { hooksByEvent, totalHooksCount } = useMemo(() => {
    const byEvent: Partial<Record<HookEvent, number>> = {}
    let total = 0
    for (const [event, matchers] of Object.entries(hooksByEventAndMatcher)) {
      const eventCount = Object.values(matchers).reduce(
        (sum, hooks) => sum + hooks.length,
        0,
      )
      byEvent[event as HookEvent] = eventCount
      total += eventCount
    }
    return { hooksByEvent: byEvent, totalHooksCount: total }
  }, [hooksByEventAndMatcher])

  // If hooks are disabled, show an informational screen.
  // The menu is read-only, so we don't offer a re-enable button —
  // users can edit settings.json or ask Claude instead.
  if (hooksDisabled) {
    return (
      <Dialog
        title="Hook Configuration - Disabled"
        onCancel={handleExit}
        inputGuide={() => <Text>Esc to close</Text>}
      >
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text>
              All hooks are currently <Text bold>disabled</Text>
              {disabledByPolicy && ' by a managed settings file'}. You have{' '}
              <Text bold>{totalHooksCount}</Text> configured{' '}
              {plural(totalHooksCount, 'hook')} that{' '}
              {plural(totalHooksCount, 'is', 'are')} not running.
            </Text>
            <Box marginTop={1}>
              <Text dimColor>When hooks are disabled:</Text>
            </Box>
            <Text dimColor>· No hook commands will execute</Text>
            <Text dimColor>· StatusLine will not be displayed</Text>
            <Text dimColor>
              · Tool operations will proceed without hook validation
            </Text>
          </Box>
          {!disabledByPolicy && (
            <Text dimColor>
              To re-enable hooks, remove &quot;disableAllHooks&quot; from
              settings.json or ask Claude.
            </Text>
          )}
        </Box>
      </Dialog>
    )
  }

  switch (modeState.mode) {
    case 'list':
      return (
        <HooksListMode
          hookEventMetadata={hookEventMetadata}
          hooksByEventAndMatcher={hooksByEventAndMatcher}
          restrictedByPolicy={restrictedByPolicy}
          defaultFocusIndex={listFocusIndex}
          onFocusRow={setListFocusIndex}
          onSelectHook={hook => {
            setModeState({
              mode: 'view-hook',
              event: hook.event,
              hook,
              from: 'list',
            })
          }}
          onOpenEvents={() => {
            setModeState({ mode: 'select-event' })
          }}
          onCancel={handleExit}
        />
      )
    case 'select-event':
      return (
        <SelectEventMode
          hookEventMetadata={hookEventMetadata}
          hooksByEvent={hooksByEvent}
          onSelectEvent={event => {
            if (getMatcherMetadata(event, combinedToolNames) !== undefined) {
              setModeState({ mode: 'select-matcher', event })
            } else {
              setModeState({ mode: 'select-hook', event, matcher: '' })
            }
          }}
          onCancel={() => {
            setModeState({ mode: 'list' })
          }}
        />
      )
    case 'select-matcher':
      return (
        <SelectMatcherMode
          selectedEvent={modeState.event}
          matchersForSelectedEvent={sortedMatchersForSelectedEvent}
          hooksByEventAndMatcher={hooksByEventAndMatcher}
          eventDescription={hookEventMetadata[modeState.event].description}
          onSelect={matcher => {
            setModeState({
              mode: 'select-hook',
              event: modeState.event,
              matcher,
            })
          }}
          onCancel={() => {
            setModeState({ mode: 'select-event' })
          }}
        />
      )
    case 'select-hook':
      return (
        <SelectHookMode
          selectedEvent={modeState.event}
          selectedMatcher={modeState.matcher}
          hooksForSelectedMatcher={hooksForSelectedMatcher}
          hookEventMetadata={hookEventMetadata[modeState.event]}
          onSelect={hook => {
            setModeState({
              mode: 'view-hook',
              event: modeState.event,
              hook,
              from: 'select-hook',
            })
          }}
          onCancel={() => {
            // Go back to matcher selection or event selection
            if (
              getMatcherMetadata(modeState.event, combinedToolNames) !==
              undefined
            ) {
              setModeState({
                mode: 'select-matcher',
                event: modeState.event,
              })
            } else {
              setModeState({ mode: 'select-event' })
            }
          }}
        />
      )
    case 'view-hook':
      return (
        <ViewHookMode
          selectedHook={modeState.hook}
          eventSupportsMatcher={
            getMatcherMetadata(modeState.event, combinedToolNames) !== undefined
          }
          onCancel={closeViewHook}
        />
      )
  }
}
