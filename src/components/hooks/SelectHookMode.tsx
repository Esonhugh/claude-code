/**
 * SelectHookMode shows all hooks configured for a given event+matcher pair.
 *
 * The /hooks menu is read-only: this view no longer offers "add new hook"
 * and selecting a hook shows its read-only details instead of a delete
 * confirmation.
 */
import * as React from 'react'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { HookEventMetadata } from 'src/utils/hooks/hooksConfigManager.js'
import { Box, Text } from '../../ink.js'
import {
  getHookDisplayText,
  hookSourceHeaderDisplayString,
  type IndividualHookConfig,
} from '../../utils/hooks/hooksSettings.js'
import { Dialog } from '../design-system/Dialog.js'
import { MenuList } from '../design-system/MenuList.js'

type Props = {
  selectedEvent: HookEvent
  selectedMatcher: string | null
  hooksForSelectedMatcher: IndividualHookConfig[]
  hookEventMetadata: HookEventMetadata
  onSelect: (hook: IndividualHookConfig) => void
  onCancel: () => void
}

export function SelectHookMode({
  selectedEvent,
  selectedMatcher,
  hooksForSelectedMatcher,
  hookEventMetadata,
  onSelect,
  onCancel,
}: Props): React.ReactNode {
  const title =
    hookEventMetadata.matcherMetadata !== undefined
      ? `${selectedEvent} - Matcher: ${selectedMatcher || '(all)'}`
      : selectedEvent

  if (hooksForSelectedMatcher.length === 0) {
    return (
      <Dialog
        title={title}
        subtitle={hookEventMetadata.description}
        onCancel={onCancel}
        inputGuide={() => <Text>Esc to go back</Text>}
      >
        <Box flexDirection="column" gap={1}>
          <Text dimColor>No hooks configured for this event.</Text>
          <Text dimColor>
            To add hooks, edit settings.json directly or ask Claude.
          </Text>
        </Box>
      </Dialog>
    )
  }

  return (
    <Dialog
      title={title}
      subtitle={hookEventMetadata.description}
      onCancel={onCancel}
    >
      <Box flexDirection="column">
        <MenuList
          rows={hooksForSelectedMatcher.map((hook, index) => ({
            kind: 'item',
            key: String(index),
            label: getHookDisplayText(hook.config),
            meta: [hook.config.type],
            description:
              hook.source === 'pluginHook' && hook.pluginName
                ? `${hookSourceHeaderDisplayString(hook.source)} (${hook.pluginName})`
                : hookSourceHeaderDisplayString(hook.source),
          }))}
          onSelect={index => {
            const hook = hooksForSelectedMatcher[index]
            if (hook) onSelect(hook)
          }}
        />
      </Box>
    </Dialog>
  )
}
