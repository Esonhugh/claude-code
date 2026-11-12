import React, { useCallback, useMemo } from 'react'
import { Box, Text } from '../../ink.js'
import { sanitizeToolNameForAnalytics } from '../../services/analytics/metadata.js'
import { getToolUseSummary } from '../../tools/ApplyPatchTool/UI.js'
import { shouldShowAlwaysAllowOptions } from '../../utils/permissions/permissionsLoader.js'
import { usePermissionRequestLogging } from './hooks.js'
import { PermissionDialog } from './PermissionDialog.js'
import { PermissionPrompt, type PermissionPromptOption } from './PermissionPrompt.js'
import type { PermissionRequestProps } from './PermissionRequest.js'
import { PermissionRuleExplanation } from './PermissionRuleExplanation.js'

type OptionValue = 'yes' | 'yes-session' | 'no'

const MAX_PATCH_LINES = 40

function patchLineColor(line: string): 'success' | 'error' | undefined {
  if (line.startsWith('+')) return 'success'
  if (line.startsWith('-')) return 'error'
  return undefined
}

// The patch touches several files, so it asks with the Edit rules of the
// first file that needs approval and shows the whole patch, not one diff.
export function ApplyPatchPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const patch = String((toolUseConfirm.input as { input?: unknown }).input ?? '')
  const summary = getToolUseSummary({ input: patch })
  const lines = patch.split('\n').filter(l => l !== '*** Begin Patch' && l !== '*** End Patch')
  const shown = verbose ? lines : lines.slice(0, MAX_PATCH_LINES)
  const permissionResult = toolUseConfirm.permissionResult
  // Only the accept-edits switch carries over to the other files; a path rule
  // from Edit's suggestions would cover just the first one.
  const acceptEdits =
    permissionResult.behavior === 'ask' &&
    (permissionResult.suggestions ?? []).some(s => s.type === 'setMode' && s.mode === 'acceptEdits')

  usePermissionRequestLogging(
    toolUseConfirm,
    useMemo(() => ({ completion_type: 'tool_use_single', language_name: 'none' }), []),
  )

  const handleSelect = useCallback(
    (value: OptionValue, feedback?: string) => {
      if (value === 'no') {
        toolUseConfirm.onReject(feedback)
        onReject()
      } else {
        toolUseConfirm.onAllow(
          toolUseConfirm.input,
          value === 'yes-session' ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] : [],
          feedback,
        )
      }
      onDone()
    },
    [toolUseConfirm, onDone, onReject],
  )

  const handleCancel = useCallback(() => {
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }, [toolUseConfirm, onDone, onReject])

  const options = useMemo((): PermissionPromptOption<OptionValue>[] => [
    { label: 'Yes', value: 'yes', feedbackConfig: { type: 'accept' } },
    ...(acceptEdits && shouldShowAlwaysAllowOptions()
      ? [{
          label: (
            <Text>
              Yes, and switch to <Text bold>accept edits</Text> for this session
            </Text>
          ),
          value: 'yes-session' as const,
        }]
      : []),
    { label: 'No', value: 'no', feedbackConfig: { type: 'reject' } },
  ], [acceptEdits])

  return (
    <PermissionDialog title="Apply patch" workerBadge={workerBadge}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>
          Patch <Text bold>{summary}</Text>
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {shown.map((line, i) => (
            <Text key={i} color={patchLineColor(line)} bold={line.startsWith('*** ')}>
              {line}
            </Text>
          ))}
          {shown.length < lines.length && (
            <Text dimColor>… {lines.length - shown.length} more lines</Text>
          )}
        </Box>
      </Box>
      <Box flexDirection="column">
        <PermissionRuleExplanation permissionResult={permissionResult} toolType="tool" />
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={handleCancel}
          toolAnalyticsContext={{
            toolName: sanitizeToolNameForAnalytics(toolUseConfirm.tool.name),
            isMcp: false,
          }}
        />
      </Box>
    </PermissionDialog>
  )
}
