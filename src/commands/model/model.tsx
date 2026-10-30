import chalk from 'chalk'
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { ModelPicker } from '../../components/ModelPicker.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { Text } from '../../ink.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { EffortLevel } from '../../utils/effort.js'
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js'
import {
  clearFastModeCooldown,
  isFastModeAvailable,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from '../../utils/fastMode.js'
import { MODEL_ALIASES } from '../../utils/model/aliases.js'
import {
  checkOpus1mAccess,
  checkSonnet1mAccess,
} from '../../utils/model/check1mAccess.js'
import {
  getDefaultMainLoopModelSetting,
  isOpus1mMergeEnabled,
  renderDefaultModelSetting,
} from '../../utils/model/model.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import {
  checkModelSwitch,
  getModelSwitchHookInfo,
  getPostModelSwitchContext,
} from '../../utils/model/modelSwitchHooks.js'
import { validateModel } from '../../utils/model/validateModel.js'
import { getPromptCacheFacts } from '../../utils/promptCacheFacts.js'
import type { ModelSwitchHookInfo } from '../../utils/hooks.js'

type PendingModelSwitch = {
  info: ModelSwitchHookInfo
  fromHook: boolean
  reason?: string
  apply: () => void
}

function ConfirmModelSwitch({
  pending,
  onCancel,
}: {
  pending: PendingModelSwitch
  onCancel: () => void
}): React.ReactNode {
  // Official 2.1.311 asks the same way for a hook's "ask" and for a switch
  // that would forfeit a warm prompt cache.
  const target = renderDefaultModelSetting(pending.info.toModel)
  return (
    <Dialog
      title="Switch model?"
      subtitle={
        pending.fromHook
          ? 'A PreModelSwitch hook asked you to confirm'
          : 'Your next response will be slower and use more tokens'
      }
      onCancel={onCancel}
      color="warning"
    >
      {pending.fromHook ? (
        <Text>{pending.reason ?? ''}</Text>
      ) : (
        <Text>
          This conversation is cached for the current model. Switching to{' '}
          <Text bold>{target}</Text> means the full history gets re-read on
          your next message.
        </Text>
      )}
      <Select
        onChange={value => (value === 'yes' ? pending.apply() : onCancel())}
        onCancel={onCancel}
        options={[
          { label: `Yes, switch to ${target}`, value: 'yes' },
          { label: 'No, go back', value: 'no' },
        ]}
      />
    </Dialog>
  )
}

/**
 * Run PreModelSwitch hooks for a /model switch. Returns true when the switch
 * may proceed now; otherwise it was blocked (onDone already called) or a
 * confirmation was queued via setPending.
 */
async function preModelSwitch(
  info: ModelSwitchHookInfo,
  source: 'command' | 'picker',
  context: LocalJSXCommandContext,
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void,
  setPending: (pending: PendingModelSwitch) => void,
  apply: () => void,
): Promise<boolean> {
  const verdict = await checkModelSwitch(info, source, context)
  if (verdict.decision === 'block') {
    onDone(
      `Model switch blocked by PreModelSwitch hook: ${verdict.reason ?? 'no reason given'}`,
      { display: 'system' },
    )
    return false
  }
  if (verdict.decision === 'ask') {
    setPending({ info, fromHook: true, reason: verdict.reason, apply })
    return false
  }
  const cache = getPromptCacheFacts(context.messages, info.fromModel)
  if (
    info.toModel !== info.fromModel &&
    cache !== undefined &&
    !cache.promptCacheLikelyExpired
  ) {
    setPending({ info, fromHook: false, apply })
    return false
  }
  return true
}

function ModelPickerWrapper({
  onDone,
  context,
}: {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay; metaMessages?: string[] },
  ) => void
  context: LocalJSXCommandContext
}): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  const isFastMode = useAppState(s => s.fastMode)
  const setAppState = useSetAppState()
  const [pending, setPending] = React.useState<PendingModelSwitch>()

  function handleCancel(): void {
    logEvent('tengu_model_command_menu', {
      action:
        'cancel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    const displayModel = renderModelLabel(mainLoopModel)
    onDone(`Kept model as ${chalk.bold(displayModel)}`, {
      display: 'system',
    })
  }

  function handleSelect(
    model: string | null,
    effort: EffortLevel | undefined,
  ): void {
    const info = getModelSwitchHookInfo(model, context.messages)
    const apply = () => void applySelect(model, effort, info)
    void preModelSwitch(info, 'picker', context, onDone, setPending, apply).then(
      proceed => {
        if (proceed) apply()
      },
    )
  }

  function handleSelectForSession(
    model: string | null,
    effort: EffortLevel | undefined,
  ): void {
    const info = getModelSwitchHookInfo(model, context.messages)
    const apply = () => void applySelect(model, effort, info, true)
    void preModelSwitch(info, 'picker', context, onDone, setPending, apply).then(
      proceed => {
        if (proceed) apply()
      },
    )
  }

  async function applySelect(
    model: string | null,
    effort: EffortLevel | undefined,
    info: ModelSwitchHookInfo,
    forSession = false,
  ): Promise<void> {
    logEvent('tengu_model_command_menu', {
      action:
        model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      from_model:
        mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      to_model:
        model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    // A session-only pick rides mainLoopModelForSession so the saved default
    // (mainLoopModel → userSettings) stays as it was.
    setAppState(prev =>
      forSession
        ? { ...prev, mainLoopModelForSession: model ?? getDefaultMainLoopModelSetting() }
        : { ...prev, mainLoopModel: model, mainLoopModelForSession: null },
    )

    let message = `Set model to ${chalk.bold(renderModelLabel(model))}${forSession ? ' for this session only' : ' and saved as your default for new sessions'}`
    if (effort !== undefined) {
      message += ` with ${chalk.bold(effort)} effort`
    }

    // Turn off fast mode if switching to unsupported model
    let wasFastModeToggledOn = undefined
    if (isFastModeEnabled()) {
      clearFastModeCooldown()
      if (!isFastModeSupportedByModel(model) && isFastMode) {
        setAppState(prev => ({
          ...prev,
          fastMode: false,
        }))
        wasFastModeToggledOn = false
        // Do not update fast mode in settings since this is an automatic downgrade
      } else if (
        isFastModeSupportedByModel(model) &&
        isFastModeAvailable() &&
        isFastMode
      ) {
        message += ` · Fast mode ON`
        wasFastModeToggledOn = true
      }
    }

    if (
      isBilledAsExtraUsage(
        model,
        wasFastModeToggledOn === true,
        isOpus1mMergeEnabled(),
      )
    ) {
      message += ` · Billed as extra usage`
    }

    if (wasFastModeToggledOn === false) {
      // Fast mode was toggled off, show suffix after extra usage billing
      message += ` · Fast mode OFF`
    }

    onDone(message, {
      metaMessages: await getPostModelSwitchContext(info, 'picker', context),
    })
  }

  if (pending) {
    return <ConfirmModelSwitch pending={pending} onCancel={handleCancel} />
  }

  return (
    <ModelPicker
      initial={mainLoopModel}
      sessionModel={mainLoopModelForSession}
      onSelect={handleSelect}
      onSelectForSession={handleSelectForSession}
      onCancel={handleCancel}
      isStandaloneCommand
      showFastModeNotice={
        isFastModeEnabled() &&
        isFastMode &&
        isFastModeSupportedByModel(mainLoopModel) &&
        isFastModeAvailable()
      }
    />
  )
}

function SetModelAndClose({
  args,
  onDone,
  context,
}: {
  args: string
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay; metaMessages?: string[] },
  ) => void
  context: LocalJSXCommandContext
}): React.ReactNode {
  const isFastMode = useAppState(s => s.fastMode)
  const setAppState = useSetAppState()
  const [pending, setPending] = React.useState<PendingModelSwitch>()
  const model = args === 'default' ? null : args

  React.useEffect(() => {
    async function handleModelChange(): Promise<void> {
      if (model && !isModelAllowed(model)) {
        onDone(
          `Model '${model}' is not available. Your organization restricts model selection.`,
          { display: 'system' },
        )
        return
      }

      // @[MODEL LAUNCH]: Update check for 1M access.
      if (model && isOpus1mUnavailable(model)) {
        onDone(
          `Opus 4.6 with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m`,
          { display: 'system' },
        )
        return
      }

      if (model && isSonnet1mUnavailable(model)) {
        onDone(
          `Sonnet 4.6 with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m`,
          { display: 'system' },
        )
        return
      }

      // Skip validation for default model
      if (!model) {
        await switchModel(null)
        return
      }

      // Skip validation for known aliases - they're predefined and should work
      if (isKnownAlias(model)) {
        await switchModel(model)
        return
      }

      // Validate and set custom model
      try {
        // Don't use parseUserSpecifiedModel for non-aliases since it lowercases the input
        // and model names are case-sensitive
        const { valid, error } = await validateModel(model)

        if (valid) {
          await switchModel(model)
        } else {
          onDone(error || `Model '${model}' not found`, {
            display: 'system',
          })
        }
      } catch (error) {
        onDone(`Failed to validate model: ${(error as Error).message}`, {
          display: 'system',
        })
      }
    }

    async function switchModel(modelValue: string | null): Promise<void> {
      const info = getModelSwitchHookInfo(modelValue, context.messages)
      const apply = () => void setModel(modelValue, info)
      if (
        await preModelSwitch(info, 'command', context, onDone, setPending, apply)
      ) {
        apply()
      }
    }

    async function setModel(
      modelValue: string | null,
      info: ModelSwitchHookInfo,
    ): Promise<void> {
      setAppState(prev => ({
        ...prev,
        mainLoopModel: modelValue,
        mainLoopModelForSession: null,
      }))
      let message = `Set model to ${chalk.bold(renderModelLabel(modelValue))} and saved as your default for new sessions`

      let wasFastModeToggledOn = undefined
      if (isFastModeEnabled()) {
        clearFastModeCooldown()
        if (!isFastModeSupportedByModel(modelValue) && isFastMode) {
          setAppState(prev => ({
            ...prev,
            fastMode: false,
          }))
          wasFastModeToggledOn = false
          // Do not update fast mode in settings since this is an automatic downgrade
        } else if (isFastModeSupportedByModel(modelValue) && isFastMode) {
          message += ` · Fast mode ON`
          wasFastModeToggledOn = true
        }
      }

      if (
        isBilledAsExtraUsage(
          modelValue,
          wasFastModeToggledOn === true,
          isOpus1mMergeEnabled(),
        )
      ) {
        message += ` · Billed as extra usage`
      }

      if (wasFastModeToggledOn === false) {
        // Fast mode was toggled off, show suffix after extra usage billing
        message += ` · Fast mode OFF`
      }

      onDone(message, {
        metaMessages: await getPostModelSwitchContext(info, 'command', context),
      })
    }

    void handleModelChange()
  }, [model, onDone, setAppState, context])

  if (pending) {
    return (
      <ConfirmModelSwitch
        pending={pending}
        onCancel={() =>
          onDone(`Kept model as ${chalk.bold(renderModelLabel(pending.info.fromModel))}`, {
            display: 'system',
          })
        }
      />
    )
  }
  return null
}

function isKnownAlias(model: string): boolean {
  return (MODEL_ALIASES as readonly string[]).includes(
    model.toLowerCase().trim(),
  )
}

function isOpus1mUnavailable(model: string): boolean {
  const m = model.toLowerCase()
  return (
    !checkOpus1mAccess() &&
    !isOpus1mMergeEnabled() &&
    m.includes('opus') &&
    m.includes('[1m]')
  )
}

function isSonnet1mUnavailable(model: string): boolean {
  const m = model.toLowerCase()
  // Warn about Sonnet and Sonnet 4.6, but not Sonnet 4.5 since that had
  // a different access criteria.
  return (
    !checkSonnet1mAccess() &&
    (m.includes('sonnet[1m]') || m.includes('sonnet-4-6[1m]'))
  )
}

function ShowModelAndClose({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  const effortValue = useAppState(s => s.effortValue)
  const displayModel = renderModelLabel(mainLoopModel)
  const effortInfo =
    effortValue !== undefined ? ` (effort: ${effortValue})` : ''

  if (mainLoopModelForSession) {
    onDone(
      `Current model: ${chalk.bold(renderModelLabel(mainLoopModelForSession))} (session override from plan mode)\nBase model: ${displayModel}${effortInfo}`,
    )
  } else {
    onDone(`Current model: ${displayModel}${effortInfo}`)
  }

  return null
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  args = args?.trim() || ''
  if (COMMON_INFO_ARGS.includes(args)) {
    logEvent('tengu_model_command_inline_help', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return <ShowModelAndClose onDone={onDone} />
  }
  if (COMMON_HELP_ARGS.includes(args)) {
    onDone(
      'Run /model to open the model selection menu, or /model [modelName] to set the model.',
      { display: 'system' },
    )
    return
  }

  if (args) {
    logEvent('tengu_model_command_inline', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return <SetModelAndClose args={args} onDone={onDone} context={context} />
  }

  return <ModelPickerWrapper onDone={onDone} context={context} />
}

function renderModelLabel(model: string | null): string {
  const rendered = renderDefaultModelSetting(
    model ?? getDefaultMainLoopModelSetting(),
  )
  return model === null ? `${rendered} (default)` : rendered
}
