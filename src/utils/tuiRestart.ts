import type { CommandUnknownOpts as Command } from '@commander-js/extra-typings'
import type { Message } from '../types/message.js'
import { isAbsolute, resolve } from 'path'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
} from '../bootstrap/state.js'
import { isInBundledMode } from './bundledMode.js'
import { gracefulShutdown } from './gracefulShutdown.js'
import { persistSessionForRestart, getProjectDir } from './sessionStorage.js'

const EXCLUDED_OPTIONS = new Set([
  // Session selection and startup-only entry modes must be replaced by the
  // active session identity below, never replayed from the original command.
  'continue',
  'forkSession',
  'fromPr',
  'resume',
  'resumeSessionAt',
  'rewindFiles',
  'sessionId',
  'teleport',
  'remote',
  'remoteControl',
  'rc',
  'sdkUrl',
  'worktree',
  'tmux',

  // These flags select non-interactive or one-shot startup paths rather than
  // the local TUI that requested the restart.
  'init',
  'initOnly',
  'maintenance',
  'print',
  'outputFormat',
  'inputFormat',
  'jsonSchema',
  'includeHookEvents',
  'includePartialMessages',
  'maxBudgetUsd',
  'maxThinkingTokens',
  'maxTurns',
  'noSessionPersistence',
  'permissionPromptTool',
  'replayUserMessages',
  'taskBudget',
  'workload',
  'file',
  'prefill',
  'deepLinkOrigin',
  'deepLinkRepo',
  'deepLinkLastFetch',

  // Remote/teammate process identity must not leak into a local TUI restart.
  'agentId',
  'agentName',
  'agentColor',
  'agentType',
  'assistant',
  'parentSessionId',
  'planModeRequired',
  'teamName',
  'teammateMode',
])

type TuiRestartConfiguration = {
  moduleLaunchArgs: string[]
  optionArgs: string[]
}

let restartConfiguration: TuiRestartConfiguration | undefined

function serializeOption(
  command: Command,
  option: Command['options'][number],
): string[] {
  const key = option.attributeName()
  if (
    EXCLUDED_OPTIONS.has(key) ||
    command.getOptionValueSource(key) !== 'cli'
  ) {
    return []
  }

  const flag = option.long ?? option.short
  if (!flag) return []

  // These options deliberately parse to true; debug.ts reads their raw values.
  if (key === 'debug' || key === 'debugFile') {
    const index = process.argv.findIndex(
      (arg) =>
        arg === flag || arg === option.short || arg.startsWith(`${flag}=`),
    )
    const raw = process.argv[index]
    if (raw) {
      if (raw.startsWith(`${flag}=`)) return [raw]
      const next = process.argv[index + 1]
      return next !== undefined && (option.required || !next.startsWith('-'))
        ? [raw, next]
        : [raw]
    }
  }

  const value = command.getOptionValue(key)
  if (option.negate) return value === false ? [flag] : []
  if (option.isBoolean() || value === true) return value === true ? [flag] : []

  if (Array.isArray(value)) {
    if (option.variadic)
      return value.length > 0 ? [flag, ...value.map(String)] : []
    return value.flatMap((item) => [flag, String(item)])
  }

  return value === undefined ? [] : [flag, String(value)]
}

export function configureTuiRestart(command: Command): void {
  const sourceEntry = process.argv[1]
  const moduleLaunchArgs = isInBundledMode()
    ? []
    : sourceEntry
      ? [
          isAbsolute(sourceEntry)
            ? sourceEntry
            : resolve(process.cwd(), sourceEntry),
        ]
      : []

  restartConfiguration = {
    moduleLaunchArgs,
    optionArgs: command.options.flatMap((option) =>
      serializeOption(command, option),
    ),
  }
}

export function canRestartTui(): boolean {
  return (
    restartConfiguration !== undefined &&
    process.platform !== 'win32' &&
    typeof process.execve === 'function'
  )
}

export async function restartTui(messages: Message[]): Promise<void> {
  const configuration = restartConfiguration
  if (!configuration || !canRestartTui()) {
    throw new Error('TUI restart is not supported in this process')
  }

  const originalCwd = getOriginalCwd()
  const sessionProjectDir = getSessionProjectDir()
  const originalProjectDir = getProjectDir(originalCwd)
  if (
    sessionProjectDir !== null &&
    resolve(sessionProjectDir) !== resolve(originalProjectDir)
  ) {
    throw new Error(
      'Cannot restart a session loaded from another project; resume it from its original project instead.',
    )
  }

  await persistSessionForRestart(messages)

  const sessionId = getSessionId()

  process.chdir(originalCwd)
  await gracefulShutdown(0, 'other', {
    restartArgs: [
      ...configuration.moduleLaunchArgs,
      ...configuration.optionArgs,
      '--resume',
      sessionId,
    ],
  })
}
