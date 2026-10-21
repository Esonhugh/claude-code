import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  getAutoCompactWindowModelKey,
  getConfiguredAutoCompactWindow,
  isAutoCompactEnabled,
  resolveAutoCompactWindow,
} from '../../services/compact/autoCompact.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  type ContextWindowSource,
  parseCompactionWindow,
  resolveContextWindow,
} from '../../utils/context.js'
import { formatTokens } from '../../utils/format.js'
import { renderModelName } from '../../utils/model/model.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

export const ENV_PRECEDENCE_MESSAGE =
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW is set and takes precedence. Unset it to change this setting.'

const SOURCE_LABELS: Partial<Record<ContextWindowSource, string>> = {
  env: 'from CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'unknown-model': 'default for an unrecognized model',
  'model-default': 'default for this model',
  settings: 'from settings',
}

export type AutoCompactWindowState = {
  modelName: string
  window: number
  configured: number
  source: ContextWindowSource
  /** e.g. "auto", "300k tokens (from settings)". */
  label: string
}

export function getAutoCompactWindowState(model: string): AutoCompactWindowState {
  const { window, source } = resolveAutoCompactWindow(model)
  const configured =
    source === 'settings'
      ? (getConfiguredAutoCompactWindow(model) ?? window)
      : window
  const capped =
    configured > window ? ` · capped to ${formatTokens(window)} by model` : ''
  const label =
    source === 'auto'
      ? 'auto'
      : source === 'experiment' || source === 'clientdata'
        ? `auto (${formatTokens(configured)} tokens)${capped}`
        : `${formatTokens(configured)} tokens (${SOURCE_LABELS[source]})${capped}`
  return {
    modelName: renderModelName(model),
    window,
    configured,
    source,
    label,
  }
}

/** Official MPn: the chosen window, capped by the model, exceeds auto's. */
export function isAboveAutoWindow(model: string, tokens: number): boolean {
  return (
    resolveContextWindow(model, tokens).window >
    resolveContextWindow(model).window
  )
}

export function describeAutoCompactWindow(model: string): string {
  const state = getAutoCompactWindowState(model)
  const lines = [`Auto-compact window for ${state.modelName}: ${state.label}`]
  if (!isAutoCompactEnabled()) {
    lines.push('Auto-compact is currently disabled (see /config)')
  }
  lines.push(
    "Auto-compact summarizes the conversation when context usage approaches this limit. The actual threshold is the minimum of this setting and your model's maximum context window.",
  )
  lines.push(
    'The auto setting picks a window tuned for your model and is strongly recommended for the best cost and performance.',
  )
  if (
    state.source === 'settings' &&
    isAboveAutoWindow(model, state.configured)
  ) {
    lines.push(
      'Overriding auto may result in high token usage, especially when resuming long sessions.',
    )
  }
  return lines.join('\n')
}

/** Official Xqe: saves the window for the current model in user settings. */
export function applyAutoCompactWindow(args: string, model: string): string {
  if (resolveAutoCompactWindow(model).source === 'env') {
    return ENV_PRECEDENCE_MESSAGE
  }
  const normalized = args.trim().toLowerCase()
  const requested: number | 'auto' | undefined =
    normalized === 'auto' ||
    normalized === 'reset' ||
    normalized === 'unset' ||
    normalized === 'default'
      ? 'auto'
      : parseCompactionWindow(normalized)
  if (requested === undefined) {
    return `Couldn't parse '${args}'. Expected 'auto' or 100k–1M tokens (e.g. 500k, 200000, or 200 as shorthand)`
  }
  const tokens = requested === 'auto' ? undefined : requested
  const key = getAutoCompactWindowModelKey(model)
  const previous = resolveAutoCompactWindow(model)
  const { error } = updateSettingsForSource('userSettings', {
    modelSettings: { [key]: { autoCompactWindow: requested } },
  })
  if (error) {
    return `Couldn't save setting: ${error.message}`
  }

  const { window, source } = resolveAutoCompactWindow(model)
  const effective =
    source === 'settings' ? getConfiguredAutoCompactWindow(model) : undefined
  const overridden = effective !== tokens
  logEvent('tengu_autocompact_command', {
    action: (requested === 'auto'
      ? 'auto'
      : 'set') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(tokens !== undefined && { tokens }),
    previous_tokens: previous.window,
    resulting_tokens: window,
    overridden,
  })

  const prefix = `Auto-compact window for ${renderModelName(model)}`
  if (tokens === undefined) {
    return overridden
      ? `${prefix} set to auto in settings, but a higher-priority override is active (${formatTokens(window)} tokens)`
      : `${prefix} set to auto`
  }
  const suffix = overridden
    ? `, but a higher-priority override is active (${formatTokens(window)} tokens)`
    : window < tokens
      ? ` (capped to model limit of ${formatTokens(window)})`
      : ''
  return `${prefix} set to ${formatTokens(tokens)} tokens${suffix}`
}

export async function call(
  args: string,
  context: ToolUseContext,
): Promise<{ type: 'text'; value: string }> {
  const model = context.options.mainLoopModel
  const trimmed = args.trim()
  return {
    type: 'text',
    value: trimmed
      ? applyAutoCompactWindow(trimmed, model)
      : describeAutoCompactWindow(model),
  }
}
