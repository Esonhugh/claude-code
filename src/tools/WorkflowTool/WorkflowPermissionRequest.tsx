import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { useNotifications } from '../../context/notifications.js'
import { getCwd } from '../../utils/cwd.js'
import { editPromptInEditor } from '../../utils/promptEditor.js'
import { sanitizeToolNameForAnalytics } from '../../services/analytics/metadata.js'
import type { PermissionRequestProps } from '../../components/permissions/PermissionRequest.js'
import { PermissionDialog } from '../../components/permissions/PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
  type ToolAnalyticsContext,
} from '../../components/permissions/PermissionPrompt.js'
import { PermissionRuleExplanation } from '../../components/permissions/PermissionRuleExplanation.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import {
  mapWorkflowPermissionSelectionToResult,
  workflowInputWithEditedScript,
  workflowPermissionInitialInput,
  workflowNameFromToolInput,
  workflowPermissionPreviewModelFromToolInput,
  workflowScriptFromToolInput,
  type WorkflowPermissionSelection,
  type WorkflowPermissionToolInput,
} from './WorkflowPermissionRequestModel.js'

export function WorkflowPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const [showRawScript, setShowRawScript] = useState(false)
  const [currentInput, setCurrentInput] = useState(() =>
    workflowPermissionInitialInput(
      toolUseConfirm.input as WorkflowPermissionToolInput,
      ('updatedInput' in toolUseConfirm.permissionResult
        ? (toolUseConfirm.permissionResult.updatedInput as
            | WorkflowPermissionToolInput
            | undefined)
        : undefined),
    ),
  )
  const [scriptEdited, setScriptEdited] = useState(false)
  const { addNotification } = useNotifications()
  const cwd = getCwd()
  const workflowName = workflowNameFromToolInput(currentInput)
  const preview = workflowPermissionPreviewModelFromToolInput(currentInput)
  const script = workflowScriptFromToolInput(currentInput)

  const options = useMemo(
    (): PermissionPromptOption<WorkflowPermissionSelection>[] => [
      {
        label: 'Yes, run it',
        value: 'yes',
        feedbackConfig: { type: 'accept' },
      },
      {
        label: (
          <Text>
            Yes, and don&apos;t ask again for <Text bold>{workflowName}</Text> in{' '}
            <Text bold>{cwd}</Text>
          </Text>
        ),
        value: 'yes-always',
      },
      {
        label: showRawScript ? 'Hide raw script' : 'View raw script',
        value: 'view-raw',
      },
      {
        label: 'No',
        value: 'no',
        feedbackConfig: { type: 'reject' },
      },
    ],
    [cwd, showRawScript, workflowName],
  )

  const handleSelect = useCallback(
    (value: WorkflowPermissionSelection, feedback?: string) => {
      const result = mapWorkflowPermissionSelectionToResult(
        value,
        currentInput,
        cwd,
        feedback,
      )
      if (result.behavior === 'view-raw') {
        setShowRawScript(prev => !prev)
        toolUseConfirm.onUserInteraction()
        return
      }
      if (result.behavior === 'allow') {
        toolUseConfirm.onAllow(
          result.updatedInput,
          result.permissionUpdates,
          result.feedback,
        )
        onDone()
        return
      }
      toolUseConfirm.onReject(result.feedback)
      onReject()
      onDone()
    },
    [cwd, currentInput, onDone, onReject, toolUseConfirm],
  )

  const handleCancel = useCallback(() => {
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }, [onDone, onReject, toolUseConfirm])

  useKeybinding(
    'chat:externalEditor',
    async () => {
      const result = await editPromptInEditor(script)
      toolUseConfirm.onUserInteraction()
      if (result.error) {
        addNotification({
          key: 'workflow-external-editor-error',
          text: result.error,
          color: 'warning',
          priority: 'high',
        })
      }
      if (result.content !== null && result.content !== script) {
        setCurrentInput(workflowInputWithEditedScript(currentInput, result.content))
        setScriptEdited(true)
        setShowRawScript(true)
      }
    },
    { context: 'Chat', isActive: script.length > 0 },
  )

  const toolAnalyticsContext = useMemo(
    (): ToolAnalyticsContext => ({
      toolName: sanitizeToolNameForAnalytics(WORKFLOW_TOOL_NAME),
      isMcp: false,
    }),
    [],
  )

  return (
    <PermissionDialog title="Run a dynamic workflow?" workerBadge={workerBadge}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>{preview.description}</Text>
        <Text> </Text>
        <Text>
          This dynamic workflow will spin up multiple subagents across the
          following phases:
        </Text>
        {preview.phases.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {preview.phases.map((phase, index) => (
              <Box key={`${phase.title}-${index}`} flexDirection="column">
                <Text>
                  {index + 1}. {phase.title}
                  {phase.detail ? ` — ${phase.detail}` : ''}
                </Text>
                {phase.prompts.map(prompt => (
                  <Text key={prompt} dimColor>
                    · &quot;{prompt}&quot;
                  </Text>
                ))}
              </Box>
            ))}
          </Box>
        ) : (
          <Text dimColor>No static phase preview available.</Text>
        )}
        {preview.args !== undefined && (
          <Box marginTop={1}>
            <Text>args: {JSON.stringify(preview.args)}</Text>
          </Box>
        )}
        {showRawScript && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{scriptEdited ? 'Raw script (edited)' : 'Raw script'}</Text>
            <Text dimColor>{script || 'No script snapshot available.'}</Text>
          </Box>
        )}
      </Box>
      <Box flexDirection="column">
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
          toolType="tool"
        />
        <PermissionPrompt
          question={
            <Text>
              Dynamic workflows can use a lot of tokens quickly by running many
              subagents in parallel — which counts against your usage limit.
              Stop a running workflow at any time with /workflows, or disable
              dynamic workflows in /config.
            </Text>
          }
          options={options}
          onSelect={handleSelect}
          onCancel={handleCancel}
          toolAnalyticsContext={toolAnalyticsContext}
        />
        <Box paddingX={2} paddingBottom={1}>
          <Text dimColor>ctrl+g to edit script in $EDITOR</Text>
        </Box>
      </Box>
    </PermissionDialog>
  )
}
