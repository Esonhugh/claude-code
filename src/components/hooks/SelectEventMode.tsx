/**
 * SelectEventMode lists every hook event ("All events" in the /hooks menu)
 * with how many hooks each one has.
 *
 * The /hooks menu is read-only: selecting an event lets you browse its
 * configured hooks but not modify them. To add or change hooks, users should
 * edit settings.json directly or ask Claude.
 */

import * as React from 'react'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { HookEventMetadata } from 'src/utils/hooks/hooksConfigManager.js'
import { plural } from '../../utils/stringUtils.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { MenuList } from '../design-system/MenuList.js'

type Props = {
  hookEventMetadata: Record<HookEvent, HookEventMetadata>
  hooksByEvent: Partial<Record<HookEvent, number>>
  onSelectEvent: (event: HookEvent) => void
  onCancel: () => void
}

export function SelectEventMode({
  hookEventMetadata,
  hooksByEvent,
  onSelectEvent,
  onCancel,
}: Props): React.ReactNode {
  const events = Object.entries(hookEventMetadata) as [
    HookEvent,
    HookEventMetadata,
  ][]
  const withHooks = events.filter(([name]) => (hooksByEvent[name] ?? 0) > 0)
  const subtitle = `${events.length} ${plural(events.length, 'event')} · ${withHooks.length} with hooks`

  return (
    <Dialog
      title="Hook events"
      subtitle={subtitle}
      onCancel={onCancel}
      inputGuide={() => (
        <Byline>
          <KeyboardShortcutHint shortcut="Enter" action="open" />
          <KeyboardShortcutHint shortcut="Esc" action="go back" />
        </Byline>
      )}
    >
      <MenuList
        rows={events.map(([name, metadata]) => {
          const count = hooksByEvent[name] ?? 0
          return {
            kind: 'item',
            key: name,
            label: name,
            meta: count > 0 ? [`${count} ${plural(count, 'hook')}`] : [],
            description: metadata.summary,
          }
        })}
        onSelect={index => {
          const event = events[index]
          if (event) onSelectEvent(event[0])
        }}
      />
    </Dialog>
  )
}
