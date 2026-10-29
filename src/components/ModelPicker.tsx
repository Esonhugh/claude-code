import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  FAST_MODE_MODEL_DISPLAY,
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
} from 'src/utils/fastMode.js'
import { Box, Text } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import {
  convertEffortValueToLevel,
  type EffortLevel,
  getDefaultEffortForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  resolvePickerEffortPersistence,
  toPersistableEffort,
} from '../utils/effort.js'
import {
  getDefaultMainLoopModel,
  type ModelSetting,
  modelDisplayString,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import {
  getModelOptions,
  resolveServedModelAliasForPersistence,
  type ModelOption,
} from '../utils/model/modelOptions.js'
import { getAPIProvider } from '../utils/model/providers.js'
import { capitalize, plural } from '../utils/stringUtils.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { Select } from './CustomSelect/index.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Pane } from './design-system/Pane.js'
import { effortLevelToSymbol } from './EffortIndicator.js'

export type Props = {
  initial: string | null
  sessionModel?: ModelSetting
  onSelect: (model: string | null, effort: EffortLevel | undefined) => void
  onCancel?: () => void
  isStandaloneCommand?: boolean
  showFastModeNotice?: boolean
  /** Overrides the dim header line below "Select model". */
  headerText?: string
  /**
   * When true, skip writing effortLevel to userSettings on selection.
   * Used by the assistant installer wizard where the model choice is
   * project-scoped (written to the assistant's .claude/settings.json via
   * install.ts) and should not leak to the user's global ~/.claude/settings.
   */
  skipSettingsWrite?: boolean
}

const NO_PREFERENCE = '__NO_PREFERENCE__'

export function ModelPicker({
  initial,
  sessionModel,
  onSelect,
  onCancel,
  isStandaloneCommand,
  showFastModeNotice,
  headerText,
  skipSettingsWrite,
}: Props): React.ReactNode {
  const setAppState = useSetAppState()
  const exitState = useExitOnCtrlCDWithKeybindings()
  const maxVisible = 10

  const isFastMode = useAppState(s =>
    isFastModeEnabled() ? s.fastMode : false,
  )

  const [hasToggledEffort, setHasToggledEffort] = useState(false)
  const effortValue = useAppState(s => s.effortValue)
  const [effort, setEffort] = useState<EffortLevel | undefined>(
    effortValue !== undefined
      ? (toPersistableEffort(effortValue) ??
        convertEffortValueToLevel(effortValue))
      : undefined,
  )

  // Memoize all derived values to prevent re-renders
  const modelOptions = useMemo(
    () => getModelOptions(isFastMode ?? false),
    [isFastMode],
  )

  const initialValue = useMemo(
    () => resolveInitialPickerValue(initial, modelOptions),
    [initial, modelOptions],
  )
  const [focusedValue, setFocusedValue] = useState<string | undefined>(
    initialValue,
  )

  // Ensure the initial value is in the options list
  // This handles edge cases where the user's current model (e.g., 'haiku' for 3P users)
  // is not in the base options but should still be selectable and shown as selected
  const optionsWithInitial = useMemo(
    () =>
      withCurrentModelOption(modelOptions, initial, getDefaultMainLoopModel()),
    [modelOptions, initial],
  )

  const selectOptions = useMemo(
    () =>
      optionsWithInitial.map(opt => ({
        ...opt,
        value: opt.value === null ? NO_PREFERENCE : opt.value,
      })),
    [optionsWithInitial],
  )
  const initialFocusValue = useMemo(
    () =>
      selectOptions.some(_ => _.value === initialValue)
        ? initialValue
        : (selectOptions[0]?.value ?? undefined),
    [selectOptions, initialValue],
  )
  const visibleCount = Math.min(maxVisible, selectOptions.length)
  const [visibleToIndex, setVisibleToIndex] = useState(visibleCount)
  const hiddenCount = getHiddenModelCount(selectOptions.length, visibleToIndex)

  const focusedModelName = selectOptions.find(
    opt => opt.value === focusedValue,
  )?.label
  const focusedOption = selectOptions.find(opt => opt.value === focusedValue)
  const focusedModel = resolveOptionModel(focusedValue)
  const focusedEffortOptions = focusedOption?.effortOptions
  const focusedSupportsEffort = focusedOption?.disabled
    ? false
    : focusedEffortOptions
      ? focusedEffortOptions.length > 0
    : focusedModel
      ? modelSupportsEffort(focusedModel)
      : false
  const focusedSupportsMax = focusedEffortOptions
    ? focusedEffortOptions.includes('max')
    : focusedModel
      ? modelSupportsMaxEffort(focusedModel)
      : false
  const focusedDefaultEffort = getDefaultEffortLevelForOption(focusedValue, focusedOption)
  const displayEffort = effort

  const handleFocus = useCallback(
    (value: string) => {
      setFocusedValue(value)
      if (!hasToggledEffort && effortValue === undefined) {
        const option = selectOptions.find(opt => opt.value === value)
        setEffort(getDefaultEffortLevelForOption(value, option))
      }
    },
    [effortValue, hasToggledEffort, selectOptions],
  )

  const handleVisibleRangeChange = useCallback(
    ({ visibleToIndex: nextVisibleToIndex }: { visibleFromIndex: number; visibleToIndex: number }) => {
      setVisibleToIndex(nextVisibleToIndex)
    },
    [],
  )

  // Effort level cycling keybindings
  const handleCycleEffort = useCallback(
    (direction: 'left' | 'right') => {
      if (!focusedSupportsEffort) return
      setEffort(prev =>
        cycleEffortLevel(
          prev ?? focusedDefaultEffort,
          direction,
          focusedSupportsMax,
          focusedEffortOptions,
        ),
      )
      setHasToggledEffort(true)
    },
    [focusedSupportsEffort, focusedSupportsMax, focusedDefaultEffort, focusedEffortOptions],
  )

  useKeybindings(
    {
      'modelPicker:decreaseEffort': () => handleCycleEffort('left'),
      'modelPicker:increaseEffort': () => handleCycleEffort('right'),
    },
    { context: 'ModelPicker' },
  )

  function handleSelect(value: string): void {
    logEvent('tengu_model_command_menu_effort', {
      effort:
        effort as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    if (!skipSettingsWrite) {
      // Prior comes from userSettings on disk — NOT merged settings (which
      // includes project/policy layers that must not leak into the user's
      // global ~/.claude/settings.json), and NOT AppState.effortValue (which
      // includes session-ephemeral sources like --effort CLI flag).
      // See resolvePickerEffortPersistence JSDoc.
      const effortLevel = resolvePickerEffortPersistence(
        effort,
        getDefaultEffortLevelForOption(value, selectOptions.find(opt => opt.value === value)),
        getSettingsForSource('userSettings')?.effortLevel,
        hasToggledEffort,
      )
      const persistable = toPersistableEffort(effortLevel)
      if (persistable !== undefined) {
        updateSettingsForSource('userSettings', { effortLevel: persistable })
      }
      setAppState(prev => ({ ...prev, effortValue: effortLevel }))
    }

    const selectedModel = resolveOptionModel(value)
    const selectedOption = selectOptions.find(opt => opt.value === value)
    const selectedSupportsEffort = selectedOption?.disabled
      ? false
      : selectedOption?.effortOptions
        ? selectedOption.effortOptions.length > 0
      : selectedModel
        ? modelSupportsEffort(selectedModel)
        : false
    const selectedEffort =
      hasToggledEffort && selectedModel && selectedSupportsEffort
        ? effort
        : undefined
    if (value === NO_PREFERENCE) {
      onSelect(null, selectedEffort)
      return
    }
    onSelect(
      resolveServedModelAliasForPersistence(value as ModelSetting),
      selectedEffort,
    )
  }

  const content = (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text color="remember" bold>
            Select model
          </Text>
          <Text dimColor>
            {headerText ??
              (getAPIProvider() === 'openai'
                ? 'Switch between OpenAI models. Applies to this session and future Claude Code sessions. For other model names, specify with --model.'
                : 'Switch between Claude models. Applies to this session and future Claude Code sessions. For other/previous model names, specify with --model.')}
          </Text>
          {sessionModel && (
            <Text dimColor>
              Currently using {modelDisplayString(sessionModel)} for this
              session (set by plan mode). Selecting a model will undo this.
            </Text>
          )}
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="column">
            <Select
              defaultValue={initialValue}
              defaultFocusValue={initialFocusValue}
              options={selectOptions}
              onChange={handleSelect}
              onFocus={handleFocus}
              onVisibleRangeChange={handleVisibleRangeChange}
              onCancel={onCancel ?? (() => {})}
              visibleOptionCount={visibleCount}
            />
          </Box>
          {hiddenCount > 0 && (
            <Box paddingLeft={3}>
              <Text dimColor>… +{hiddenCount} {plural(hiddenCount, 'model')}</Text>
            </Box>
          )}
        </Box>

        {!focusedOption?.disabled && (
          <Box marginBottom={1} flexDirection="column">
            {focusedSupportsEffort ? (
            <Text dimColor>
              <EffortLevelIndicator effort={displayEffort} />{' '}
              {formatEffortLevel(displayEffort)} effort
              {displayEffort === focusedDefaultEffort ? ` (default)` : ``}{' '}
              <Text color="subtle">← → to adjust</Text>
            </Text>
            ) : (
              <Text color="subtle">
                <EffortLevelIndicator effort={undefined} /> Effort not supported
                {focusedModelName ? ` for ${focusedModelName}` : ''}
              </Text>
            )}
          </Box>
        )}

        {isFastModeEnabled() ? (
          showFastModeNotice ? (
            <Box marginBottom={1}>
              <Text dimColor>
                {getAPIProvider() === 'openai' ? (
                  <>
                    Fast mode is <Text bold>ON</Text> (/fast).
                  </>
                ) : (
                  <>
                    Fast mode is <Text bold>ON</Text> and available with{' '}
                    {FAST_MODE_MODEL_DISPLAY} only (/fast). Switching to other models
                    turns it off.
                  </>
                )}
              </Text>
            </Box>
          ) : isFastModeAvailable() && !isFastModeCooldown() ? (
            <Box marginBottom={1}>
              <Text dimColor>
                Use <Text bold>/fast</Text> to turn on Fast mode
                {getAPIProvider() === 'openai'
                  ? '.'
                  : ` (${FAST_MODE_MODEL_DISPLAY} only).`}
              </Text>
            </Box>
          ) : null
        ) : null}
      </Box>

      {isStandaloneCommand && (
        <Text dimColor italic>
          {exitState.pending ? (
            <>Press {exitState.keyName} again to exit</>
          ) : (
            focusedOption?.disabled ? (
              <ConfigurableShortcutHint
                action="select:cancel"
                context="Select"
                fallback="Esc"
                description="cancel"
              />
            ) : (
              <Byline>
                <KeyboardShortcutHint shortcut="Enter" action="confirm" />
                <ConfigurableShortcutHint
                  action="select:cancel"
                  context="Select"
                  fallback="Esc"
                  description="exit"
                />
              </Byline>
            )
          )}
        </Text>
      )}
    </Box>
  )

  if (!isStandaloneCommand) {
    return content
  }

  return <Pane color="permission">{content}</Pane>
}

function resolveOptionModel(value?: string): string | undefined {
  if (!value) return undefined
  return value === NO_PREFERENCE
    ? getDefaultMainLoopModel()
    : parseUserSpecifiedModel(value)
}

/**
 * Keeps the current model selectable and marked: a custom model missing from
 * the list is appended, and when nothing is set but the provider list (e.g.
 * OpenAI or a gateway) has no default row, the default model is added first.
 */
export function withCurrentModelOption(
  options: ModelOption[],
  initial: string | null,
  defaultModel: string,
): ModelOption[] {
  if (initial === null) {
    if (options.some(option => option.value === null)) return options
    return [
      {
        value: null,
        label: `Default (${modelDisplayString(defaultModel)})`,
        description: 'Current model',
      },
      ...options,
    ]
  }
  if (options.some(option => option.value === resolveInitialPickerValue(initial, options))) {
    return options
  }
  return [
    ...options,
    { value: initial, label: modelDisplayString(initial), description: 'Current model' },
  ]
}

export function resolveInitialPickerValue(
  initial: string | null,
  options: ModelOption[],
): string {
  if (initial === null) return NO_PREFERENCE
  if (options.some(option => option.value === initial)) return initial
  const resolved = parseUserSpecifiedModel(initial)
  return options.some(option => option.value === resolved) ? resolved : initial
}

export function getHiddenModelCount(totalCount: number, visibleToIndex: number): number {
  return Math.max(0, totalCount - visibleToIndex)
}

export function formatEffortLevel(level: EffortLevel | undefined): string {
  if (level === undefined) return ''
  return level === 'xhigh' ? 'xHigh' : capitalize(level)
}

function EffortLevelIndicator({
  effort,
}: {
  effort?: EffortLevel
}): React.ReactNode {
  return (
    <Text color={effort ? 'claude' : 'subtle'}>
      {effortLevelToSymbol(effort ?? 'low')}
    </Text>
  )
}

export function cycleEffortLevel(
  current: EffortLevel,
  direction: 'left' | 'right',
  includeMax: boolean,
  configuredLevels?: EffortLevel[],
): EffortLevel {
  const levels: EffortLevel[] = configuredLevels && configuredLevels.length > 0
    ? configuredLevels
    : includeMax
      ? ['minimal', 'low', 'medium', 'high', 'max']
      : ['minimal', 'low', 'medium', 'high']
  // If the current level isn't in the cycle (e.g. 'max' after switching to a
  // non-Opus model), clamp to 'high'.
  const idx = levels.indexOf(current)
  const currentIndex = idx !== -1 ? idx : levels.indexOf('high')
  if (direction === 'right') {
    return levels[(currentIndex + 1) % levels.length]!
  } else {
    return levels[(currentIndex - 1 + levels.length) % levels.length]!
  }
}

function getDefaultEffortLevelForOption(
  value?: string,
  option?: Pick<ModelOption, 'defaultEffort'>,
): EffortLevel {
  if (option?.defaultEffort) return option.defaultEffort
  const resolved = resolveOptionModel(value) ?? getDefaultMainLoopModel()
  const defaultValue = getDefaultEffortForModel(resolved)
  return defaultValue !== undefined
    ? convertEffortValueToLevel(defaultValue)
    : 'high'
}
