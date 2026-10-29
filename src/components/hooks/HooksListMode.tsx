/**
 * HooksListMode is the entrypoint of the read-only /hooks menu: it lists the
 * configured hooks grouped by event, with an "All events" row that opens the
 * full event list.
 */
import * as React from 'react'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { HookEventMetadata } from 'src/utils/hooks/hooksConfigManager.js'
import { Box, Link, Text } from '../../ink.js'
import {
  getHooksForMatcher,
  getSortedMatchersForEvent,
} from '../../utils/hooks/hooksConfigManager.js'
import {
  hookSourceInlineDisplayString,
  type IndividualHookConfig,
} from '../../utils/hooks/hooksSettings.js'
import { plural } from '../../utils/stringUtils.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { HooksList, type HooksListRow } from './HooksList.js'
import { getContentFieldValue } from './ViewHookMode.js'

type Props = {
  hookEventMetadata: Record<HookEvent, HookEventMetadata>
  hooksByEventAndMatcher: Record<
    HookEvent,
    Record<string, IndividualHookConfig[]>
  >
  restrictedByPolicy: boolean
  defaultFocusIndex: number
  onFocusRow: (index: number) => void
  onSelectHook: (hook: IndividualHookConfig) => void
  onOpenEvents: () => void
  onCancel: () => void
}

export function HooksListMode({
  hookEventMetadata,
  hooksByEventAndMatcher,
  restrictedByPolicy,
  defaultFocusIndex,
  onFocusRow,
  onSelectHook,
  onOpenEvents,
  onCancel,
}: Props): React.ReactNode {
  const groups = (
    Object.entries(hookEventMetadata) as [HookEvent, HookEventMetadata][]
  ).flatMap(([event, metadata]) => {
    const hooks = getSortedMatchersForEvent(
      hooksByEventAndMatcher,
      event,
    ).flatMap(matcher =>
      getHooksForMatcher(hooksByEventAndMatcher, event, matcher),
    )
    return hooks.length > 0 ? [{ event, metadata, hooks }] : []
  })
  const hooks = groups.flatMap(group => group.hooks)

  const subtitle =
    hooks.length === 0
      ? restrictedByPolicy
        ? 'managed hooks only'
        : 'no hooks yet'
      : `${hooks.length} ${plural(hooks.length, 'hook')} on ${groups.length} ${plural(groups.length, 'event')}`

  const rows: HooksListRow[] = groups.flatMap((group, groupIndex) => [
    ...(groupIndex > 0
      ? [{ kind: 'heading' as const, key: `${group.event}-gap` }]
      : []),
    {
      kind: 'heading' as const,
      key: `${group.event}-heading`,
      content: (
        <>
          <Text bold>{group.event}</Text>
          <Text dimColor>
            {'  '}
            {lowercaseFirstWord(group.metadata.summary)}
          </Text>
        </>
      ),
    },
    ...group.hooks.map((hook, index) => ({
      kind: 'item' as const,
      key: `${group.event}-${index}`,
      icon: `[${hookSourceInlineDisplayString(hook.source)}]`,
      label: firstLine(getContentFieldValue(hook.config)),
      meta: [
        hook.source === 'pluginHook' ? (hook.pluginName ?? '') : '',
        hook.matcher ?? '',
        hook.config.type,
      ],
    })),
  ])
  if (hooks.length > 0) rows.push({ kind: 'heading', key: 'events-gap' })
  rows.push({ kind: 'item', key: 'events', label: 'All events' })

  return (
    <Dialog
      title="Hooks"
      subtitle={subtitle}
      onCancel={onCancel}
      inputGuide={() => (
        <Byline>
          <KeyboardShortcutHint shortcut="Enter" action="view" />
          <KeyboardShortcutHint shortcut="Esc" action="close" />
        </Byline>
      )}
    >
      <Box flexDirection="column" gap={1}>
        {restrictedByPolicy && (
          <Box flexDirection="column">
            <Text color="suggestion">Only hooks from managed settings run here.</Text>
            <Text dimColor>
              Hooks in your own settings files (user, project and local) are
              blocked and aren&apos;t listed. Managed hooks aren&apos;t shown
              here either.
            </Text>
          </Box>
        )}
        <Text dimColor>
          This menu is read-only. To add or change a hook, edit settings.json
          or ask Claude.{' '}
          <Link url="https://code.claude.com/docs/en/hooks">Learn more</Link>
        </Text>
        <HooksList
          rows={rows}
          defaultFocusIndex={defaultFocusIndex}
          onFocus={onFocusRow}
          onSelect={index => {
            const hook = hooks[index]
            if (hook) onSelectHook(hook)
            else onOpenEvents()
          }}
        />
      </Box>
    </Dialog>
  )
}

function lowercaseFirstWord(text: string): string {
  return text.replace(/^\p{Lu}(?=\p{Ll}|\s)/u, letter => letter.toLowerCase())
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}
