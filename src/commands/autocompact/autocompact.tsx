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
  AUTO_COMPACT_WINDOW_MAX,
  AUTO_COMPACT_WINDOW_MIN,
} from '../../utils/frontmatterParser.js'
import {
  applyAutoCompactWindow,
  getAutoCompactWindowState,
  isAboveAutoWindow,
} from './autocompact-noninteractive.js'

const STEP = 100_000
// 0 stands for "auto" in the stepper.
const AUTO = 0

/** Official stepper: auto ↔ 100k … 1M in 100k steps, wrapping through auto. */
export function stepAutoCompactWindow(current: number, direction: 1 | -1): number {
  if (current === AUTO) {
    return direction > 0 ? AUTO_COMPACT_WINDOW_MIN : AUTO_COMPACT_WINDOW_MAX
  }
  const next = current + direction * STEP
  return next < AUTO_COMPACT_WINDOW_MIN || next > AUTO_COMPACT_WINDOW_MAX
    ? AUTO
    : next
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
  const [value, setValue] = React.useState(() =>
    state.source === 'settings'
      ? Math.min(
          AUTO_COMPACT_WINDOW_MAX,
          Math.max(
            AUTO_COMPACT_WINDOW_MIN,
            Math.round(state.configured / STEP) * STEP,
          ),
        )
      : AUTO,
  )
  const [touched, setTouched] = React.useState(false)
  const done = React.useRef(false)
  const unchanged = `Auto-compact window for ${state.modelName} unchanged: ${state.label}`

  const adjust = (direction: 1 | -1): void => {
    if (envLocked) return
    setTouched(true)
    setValue(current => stepAutoCompactWindow(current, direction))
  }
  const finish = (message: string): void => {
    if (done.current) return
    done.current = true
    onDone(message)
  }
  const apply = (): void => {
    if (!touched) {
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

  const valueLabel = value === AUTO ? 'auto' : `${formatTokens(value)} tokens`
  const showUsageWarning =
    value !== AUTO && isAboveAutoWindow(model, touched ? value : state.configured)

  return (
    <Dialog
      title="Auto-compact window"
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
            "This command configures when auto-compaction happens. The actual threshold is the minimum of this setting and your model's maximum context window."
          }
        </Text>
        <Text>
          The auto setting picks a window tuned for your model and is{' '}
          <Text bold>strongly recommended</Text> for the best cost and
          performance. You can override it below.
        </Text>
        {!isAutoCompactEnabled() && (
          <Text color="warning">Auto-compact is currently disabled (see /config)</Text>
        )}
        {showUsageWarning && (
          <Text color="warning">
            Overriding auto may result in high token usage, especially when
            resuming long sessions.
          </Text>
        )}
        {envLocked ? (
          <Text color="warning">
            CLAUDE_CODE_AUTO_COMPACT_WINDOW is set and takes precedence. Unset
            it to change this setting here.
          </Text>
        ) : (
          <Box>
            <Text>Select auto-compact window: </Text>
            <Text bold color="suggestion">
              {valueLabel}
            </Text>
          </Box>
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
