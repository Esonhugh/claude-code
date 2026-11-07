import * as React from 'react'
import { Byline } from '../../components/design-system/Byline.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { logEvent } from '../../services/analytics/index.js'
import { isAutoCompactEnabled } from '../../services/compact/autoCompact.js'
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'
import { formatTokens } from '../../utils/format.js'
import {
  applyAutoCompactWindow,
  getAutoCompactWindowState,
  isAboveAutoWindow,
} from './autocompact-noninteractive.js'
import { getContextWindowTiers } from '../../utils/context.js'

// 0 stands for "auto" in the slider.
const AUTO = 0

/**
 * Slider stops: auto, then the model's tiers. A saved window that is not a
 * tier (e.g. 150k) gets its own stop; one above the model's maximum selects
 * the maximum, which is what it resolves to.
 */
export function contextWindowChoices(
  tiers: number[],
  configured: number | undefined,
): { choices: number[]; index: number } {
  const choices = [AUTO, ...tiers]
  if (configured === undefined) return { choices, index: 0 }
  const selected = Math.min(configured, tiers.at(-1) ?? configured)
  if (!choices.includes(selected)) {
    choices.push(selected)
    choices.sort((a, b) => a - b)
  }
  return { choices, index: choices.indexOf(selected) }
}

function AutoCompactDialog({
  model,
  onDone,
}: {
  model: string
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const state = React.useMemo(() => getAutoCompactWindowState(model), [model])
  const envLocked = state.source === 'env'
  const { choices, index: initialIndex } = React.useMemo(
    () =>
      contextWindowChoices(
        getContextWindowTiers(model),
        state.source === 'settings' ? state.configured : undefined,
      ),
    [model, state],
  )
  const [index, setIndex] = React.useState(initialIndex)
  const done = React.useRef(false)
  const unchanged = `Auto-compact window for ${state.modelName} unchanged: ${state.label}`
  const value = choices[index]!

  const adjust = (direction: 1 | -1): void => {
    if (envLocked) return
    setIndex(i => Math.min(choices.length - 1, Math.max(0, i + direction)))
  }
  const finish = (message: string): void => {
    if (done.current) return
    done.current = true
    onDone(message)
  }
  const apply = (): void => {
    if (envLocked || index === initialIndex) {
      finish(unchanged)
      return
    }
    finish(applyAutoCompactWindow(value === AUTO ? 'auto' : String(value), model))
  }

  useKeybindings(
    {
      'select:previous': () => adjust(1),
      'select:next': () => adjust(-1),
      'select:accept': apply,
    },
    { context: 'Select' },
  )
  useKeybindings(
    {
      'tabs:next': () => adjust(1),
      'tabs:previous': () => adjust(-1),
    },
    { context: 'Tabs' },
  )

  const labels = choices.map(choice =>
    choice === AUTO ? 'auto' : formatTokens(choice),
  )
  const gap = 4
  const starts = labels.map((_, i) =>
    labels.slice(0, i).reduce((sum, label) => sum + label.length + gap, 0),
  )
  const width = starts.at(-1)! + labels.at(-1)!.length
  const marker = starts[index]! + Math.floor((labels[index]!.length - 1) / 2)
  const showUsageWarning =
    value !== AUTO && isAboveAutoWindow(model, value)

  return (
    <Dialog
      title="Context window"
      subtitle={`Current setting for ${state.modelName}: ${state.label}`}
      onCancel={() => finish(unchanged)}
      inputGuide={() => (
        <Text dimColor>
          <Byline>
            <KeyboardShortcutHint shortcut="←/→" action="adjust" />
            <KeyboardShortcutHint shortcut="Enter" action="apply" />
            <KeyboardShortcutHint shortcut="Esc" action="cancel" />
          </Byline>
        </Text>
      )}
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          {
            "The conversation is auto-compacted before it outgrows this window. A smaller window keeps every request cheaper; it never exceeds the model's maximum."
          }
        </Text>
        {!isAutoCompactEnabled() && (
          <Text color="warning">Auto-compact is currently disabled (see /config)</Text>
        )}
        {envLocked ? (
          <Text color="warning">
            CLAUDE_CODE_AUTO_COMPACT_WINDOW is set and takes precedence. Unset
            it to change this setting here.
          </Text>
        ) : (
          <Box flexDirection="column" width={Math.max(width, 24)}>
            <Box justifyContent="space-between">
              <Text>Cheaper</Text>
              <Text>More context</Text>
            </Box>
            <Text>
              <Text dimColor>{'─'.repeat(marker)}</Text>
              <Text bold>▲</Text>
              <Text dimColor>{'─'.repeat(Math.max(width, 24) - marker - 1)}</Text>
            </Text>
            <Text>
              {labels.map((label, i) => (
                <React.Fragment key={label}>
                  {i > 0 && ' '.repeat(gap)}
                  {i === index ? (
                    <Text bold color="suggestion">
                      {label}
                    </Text>
                  ) : (
                    <Text dimColor>{label}</Text>
                  )}
                </React.Fragment>
              ))}
            </Text>
          </Box>
        )}
        {showUsageWarning && (
          <Text color="warning">
            Overriding auto may result in high token usage, especially when
            resuming long sessions.
          </Text>
        )}
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const model = context.options.mainLoopModel
  const trimmed = args?.trim() ?? ''
  if (trimmed) {
    onDone(applyAutoCompactWindow(trimmed, model))
    return null
  }
  logEvent('tengu_autocompact_dialog_opened', {})
  return <AutoCompactDialog model={model} onDone={onDone} />
}
