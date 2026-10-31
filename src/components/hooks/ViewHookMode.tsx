/**
 * ViewHookMode shows read-only details for a single configured hook.
 *
 * The /hooks menu is read-only; this view replaces the former delete-hook
 * confirmation screen and directs users to settings.json or Claude for edits.
 */
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { getDisplayPath } from '../../utils/file.js'
import {
  hookSourceDescriptionDisplayString,
  type IndividualHookConfig,
} from '../../utils/hooks/hooksSettings.js'
import { getSettingsFilePathForSource } from '../../utils/settings/settings.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

type Props = {
  selectedHook: IndividualHookConfig
  eventSupportsMatcher: boolean
  onCancel: () => void
}

export function ViewHookMode({
  selectedHook,
  eventSupportsMatcher,
  onCancel,
}: Props): React.ReactNode {
  const matcher = selectedHook.matcher || 'matches everything'
  const subtitle = eventSupportsMatcher
    ? `${selectedHook.event} · ${matcher}`
    : selectedHook.event
  const statusMessage =
    'statusMessage' in selectedHook.config
      ? selectedHook.config.statusMessage
      : undefined

  return (
    <Dialog
      title={getHookTypeTitle(selectedHook.config)}
      subtitle={subtitle}
      onCancel={onCancel}
      inputGuide={() => <KeyboardShortcutHint shortcut="Esc" action="go back" />}
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <DetailRow label="Source:">
            {hookSourceDescriptionDisplayString(selectedHook.source)}
          </DetailRow>
          {selectedHook.pluginName && (
            <DetailRow label="Plugin:">{selectedHook.pluginName}</DetailRow>
          )}
          {statusMessage && (
            <DetailRow label="Status message:">{statusMessage}</DetailRow>
          )}
        </Box>
        <Box flexDirection="column">
          <Text dimColor>{getContentFieldLabel(selectedHook.config)}</Text>
          <Box
            borderColor="subtle"
            borderStyle="dashed"
            borderLeft={false}
            borderRight={false}
            paddingX={1}
          >
            <Text>{getContentFieldValue(selectedHook.config)}</Text>
          </Box>
        </Box>
        <Text dimColor>{getEditHint(selectedHook)}</Text>
      </Box>
    </Dialog>
  )
}

function DetailRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Box flexDirection="row" gap={2}>
      <Text bold>{label}</Text>
      <Text dimColor>{children}</Text>
    </Box>
  )
}

function getHookTypeTitle(config: IndividualHookConfig['config']): string {
  switch (config.type) {
    case 'command':
      return 'Command hook'
    case 'prompt':
      return 'Prompt hook'
    case 'agent':
      return 'Agent hook'
    case 'http':
      return 'HTTP hook'
  }
}

function getEditHint(hook: IndividualHookConfig): string {
  switch (hook.source) {
    case 'userSettings':
    case 'projectSettings':
    case 'localSettings': {
      const path = getSettingsFilePathForSource(hook.source)
      return `To change or remove this hook, edit ${path ? getDisplayPath(path) : 'settings.json'} or ask Claude.`
    }
    case 'pluginHook':
      return hook.pluginName
        ? `This hook comes from the ${hook.pluginName} plugin and stops running when that plugin is disabled (/plugin).`
        : 'This hook comes from a plugin and stops running when that plugin is disabled (/plugin).'
    case 'builtinHook':
      return "This hook is built in to Claude Code and can't be changed or removed."
    case 'sessionHook':
      return "This hook was registered while Claude Code was running (by /goal, an agent or a skill), not by a settings file, and can't be changed here."
    case 'policySettings':
      return "This hook is set by your organization's managed settings and can't be changed here."
  }
}

/**
 * Get a human-readable label for the primary content field of a hook
 * based on its type.
 */
function getContentFieldLabel(config: IndividualHookConfig['config']): string {
  switch (config.type) {
    case 'command':
      return 'Command'
    case 'prompt':
      return 'Prompt'
    case 'agent':
      return 'Prompt'
    case 'http':
      return 'URL'
  }
}

/**
 * Get the actual content value for a hook's primary field, bypassing
 * statusMessage so the detail view always shows the real command/prompt/URL.
 */
export function getContentFieldValue(config: IndividualHookConfig['config']): string {
  switch (config.type) {
    case 'command':
      return config.command
    case 'prompt':
      return config.prompt
    case 'agent':
      return config.prompt
    case 'http':
      return config.url
  }
}
