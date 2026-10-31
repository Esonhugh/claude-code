import * as React from 'react'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text, useInput } from '../../ink.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { Theme } from '../../utils/theme.js'
import {
  EFFORT_LEVELS,
  type EffortValue,
  getDisplayedEffortLevel,
  resolveAppliedEffort,
  getEffortEnvOverride,
  getEffortValueDescription,
  getSupportedEffortLevelsForModel,
  isEffortLevel,
  toPersistableEffort,
} from '../../utils/effort.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

const COMMON_HELP_ARGS = ['help', '-h', '--help']

export const EFFORT_HELP =
  'Usage: /effort [none|minimal|low|medium|high|xhigh|max|ultra|ultracode|auto]\n\nEffort levels:\n- none: No reasoning for latency-critical OpenAI tasks (this session only)\n- minimal: Minimal reasoning effort\n- low: Quick, straightforward implementation\n- medium: Balanced approach with standard testing\n- high: Comprehensive implementation with extensive testing\n- xhigh: Extended capability for supported Anthropic and OpenAI models\n- max: Maximum capability\n- ultra: Ultra effort\n- ultracode: xhigh + dynamic workflow orchestration\n- auto: Use the default effort level for your model'

type EffortCommandResult = {
  message: string
  effortUpdate?: { value: EffortValue | undefined }
}

function setEffortValue(
  effortValue: EffortValue,
  sessionOnly = false,
): EffortCommandResult {
  const persistable = sessionOnly ? undefined : toPersistableEffort(effortValue)
  if (persistable !== undefined) {
    const result = updateSettingsForSource('userSettings', {
      effortLevel: persistable,
    })
    if (result.error) {
      return {
        message: `Failed to set effort level: ${result.error.message}`,
      }
    }
  }
  logEvent('tengu_effort_command', {
    effort:
      effortValue as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  // Env var wins at resolveAppliedEffort time. Only flag it when it actually
  // conflicts — if env matches what the user just asked for, the outcome is
  // the same, so "Set effort to X" is true and the note is noise.
  const envOverride = getEffortEnvOverride()
  if (envOverride !== undefined && envOverride !== effortValue) {
    const envRaw = process.env.CLAUDE_CODE_EFFORT_LEVEL
    if (persistable === undefined) {
      return {
        message: `Not applied: CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides effort this session, and ${effortValue} is session-only or OpenAI-only (nothing saved)`,
        effortUpdate: { value: effortValue },
      }
    }
    return {
      message: `CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides this session — clear it and ${effortValue} takes over`,
      effortUpdate: { value: effortValue },
    }
  }

  const description = getEffortValueDescription(effortValue)
  const suffix = persistable !== undefined ? '' : ' (this session only)'
  return {
    message: `Set effort level to ${effortValue}${suffix}: ${description}`,
    effortUpdate: { value: effortValue },
  }
}

export function showCurrentEffort(
  appStateEffort: EffortValue | undefined,
  model: string,
): EffortCommandResult {
  const envOverride = getEffortEnvOverride()
  const effectiveValue =
    envOverride === null ? undefined : (envOverride ?? appStateEffort)
  if (effectiveValue === undefined) {
    const level = getDisplayedEffortLevel(model, appStateEffort)
    return { message: `Effort level: auto (currently ${level})` }
  }
  const description = getEffortValueDescription(effectiveValue)
  const suffix = effectiveValue === 'none' ? '; this session only' : ''
  const applied = resolveAppliedEffort(model, appStateEffort)
  const displayValue =
    applied !== undefined && applied !== effectiveValue
      ? `${effectiveValue} → ${applied}`
      : String(effectiveValue)
  return {
    message: `Current effort level: ${displayValue} (${description}${suffix})`,
  }
}

function unsetEffortLevel(): EffortCommandResult {
  const result = updateSettingsForSource('userSettings', {
    effortLevel: undefined,
  })
  if (result.error) {
    return {
      message: `Failed to set effort level: ${result.error.message}`,
    }
  }
  logEvent('tengu_effort_command', {
    effort:
      'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  // env=auto/unset (null) matches what /effort auto asks for, so only warn
  // when env is pinning a specific level that will keep overriding.
  const envOverride = getEffortEnvOverride()
  if (envOverride !== undefined && envOverride !== null) {
    const envRaw = process.env.CLAUDE_CODE_EFFORT_LEVEL
    return {
      message: `Cleared effort from settings, but CLAUDE_CODE_EFFORT_LEVEL=${envRaw} still controls this session`,
      effortUpdate: { value: undefined },
    }
  }
  return {
    message: 'Effort level set to auto',
    effortUpdate: { value: undefined },
  }
}

export function executeEffort(args: string): EffortCommandResult {
  const normalized = args.toLowerCase()
  if (normalized === 'auto' || normalized === 'unset') {
    return unsetEffortLevel()
  }

  if (!isEffortLevel(normalized)) {
    return {
      message: `Invalid argument: ${args}. Valid options are: ${EFFORT_LEVELS.join(', ')}, auto`,
    }
  }

  return setEffortValue(normalized)
}

function ShowCurrentEffort({
  onDone,
}: {
  onDone: (result: string) => void
}): React.ReactNode {
  const effortValue = useAppState(s => s.effortValue)
  const model = useMainLoopModel()
  const { message } = showCurrentEffort(effortValue, model)
  onDone(message)
  return null
}

// 2.1.311 slider geometry: gaps between labels, and a 14-column minimum.
const LABEL_GAPS = [5, 5, 5, 6]
const MIN_SLIDER_WIDTH = 14
const LEVEL_COLORS: Partial<Record<string, keyof Theme>> = {
  low: 'warning',
  medium: 'success',
  high: 'permission',
  xhigh: 'autoAccept',
  max: 'claude',
}

// Official 2.1.311 opens this slider for a bare /effort.
function EffortPicker({
  onDone,
}: {
  onDone: (result: string) => void
}): React.ReactNode {
  const effortValue = useAppState(s => s.effortValue)
  const model = useMainLoopModel()
  const setAppState = useSetAppState()
  const levels = getSupportedEffortLevelsForModel(model).filter(
    level => level !== 'minimal' || getAPIProvider() === 'openai',
  )
  const [index, setIndex] = React.useState(() =>
    Math.max(
      0,
      (levels as readonly string[]).indexOf(
        getDisplayedEffortLevel(model, effortValue),
      ),
    ),
  )
  const ultracodeAvailable = levels.includes('xhigh')
  const [ultracode, setUltracode] = React.useState(effortValue === 'ultracode')

  const finish = (sessionOnly: boolean) => {
    const result = setEffortValue(
      ultracode ? 'ultracode' : levels[index]!,
      sessionOnly,
    )
    if (result.effortUpdate) {
      const { value } = result.effortUpdate
      setAppState(prev => ({ ...prev, effortValue: value }))
    }
    onDone(result.message)
  }

  useInput((input, key) => {
    if (key.leftArrow) setIndex(i => Math.max(0, i - 1))
    else if (key.rightArrow) setIndex(i => Math.min(levels.length - 1, i + 1))
    else if (key.return) finish(false)
    else if (input === 's') finish(true)
    else if (key.tab && ultracodeAvailable) setUltracode(on => !on)
  })

  const gaps = levels.slice(1).map((_, i) => LABEL_GAPS[i] ?? 5)
  const labelStarts = levels.map((_, i) =>
    levels
      .slice(0, i)
      .reduce((sum, level, j) => sum + level.length + gaps[j]!, 0),
  )
  const width = Math.max(
    labelStarts.at(-1)! + levels.at(-1)!.length,
    MIN_SLIDER_WIDTH,
  )
  // The marker sits under the middle of the selected label.
  const marker =
    labelStarts[index]! + Math.floor((levels[index]!.length - 1) / 2)
  return (
    <Dialog
      title="Effort"
      onCancel={() => onDone('Cancelled')}
      inputGuide={() => (
        <Text dimColor>
          ←/→ to adjust · Enter to confirm · s for this session only · Esc to
          cancel
        </Text>
      )}
    >
      <Box flexDirection="row" justifyContent="center" width="100%">
        <Box flexDirection="column" width={width}>
          <Box justifyContent="space-between">
            <Text>Faster</Text>
            <Text>Smarter</Text>
          </Box>
          <Text>
            <Text dimColor>{'─'.repeat(marker)}</Text>
            <Text bold>▲</Text>
            <Text dimColor>{'─'.repeat(width - marker - 1)}</Text>
          </Text>
          <Text>
            {levels.map((level, i) => (
              <React.Fragment key={level}>
                {i > 0 && ' '.repeat(gaps[i - 1]!)}
                {i === index ? (
                  <Text bold color={LEVEL_COLORS[level]}>
                    {level}
                  </Text>
                ) : (
                  <Text dimColor>{level}</Text>
                )}
              </React.Fragment>
            ))}
          </Text>
        </Box>
        {ultracodeAvailable && (
          <Box flexDirection="column" marginLeft={6} marginTop={1}>
            <Text>
              Ultracode{'  '}<Text bold>{ultracode ? 'on' : 'off'}</Text>
            </Text>
            <Text dimColor>Tab to toggle</Text>
          </Box>
        )}
      </Box>
    </Dialog>
  )
}

function ApplyEffortAndClose({
  result,
  onDone,
}: {
  result: EffortCommandResult
  onDone: (result: string) => void
}): React.ReactNode {
  const setAppState = useSetAppState()
  const { effortUpdate, message } = result
  React.useEffect(() => {
    if (effortUpdate) {
      setAppState(prev => ({
        ...prev,
        effortValue: effortUpdate.value,
      }))
    }
    onDone(message)
  }, [setAppState, effortUpdate, message, onDone])
  return null
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  args = args?.trim() || ''

  if (COMMON_HELP_ARGS.includes(args)) {
    onDone(EFFORT_HELP)
    return
  }

  if (!args) {
    return <EffortPicker onDone={onDone} />
  }

  if (args === 'current' || args === 'status') {
    return <ShowCurrentEffort onDone={onDone} />
  }

  const result = executeEffort(args)
  return <ApplyEffortAndClose result={result} onDone={onDone} />
}
