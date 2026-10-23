import * as React from 'react'
import { useCallback, useState } from 'react'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  saveDynamicWorkflow,
  WORKFLOW_SAVE_OVERWRITE_HINT,
  workflowSavePathPreview,
} from '../../tools/WorkflowTool/saveDynamicWorkflow.js'
import type { WorkflowSaveScope } from '../../tools/WorkflowTool/workflowDiscovery.js'
import { getCwd } from '../../utils/cwd.js'
import { errorMessage } from '../../utils/errors.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import TextInput from '../TextInput.js'

type Props = {
  script: string
  defaultName: string
  /** Called with the saved message, or with nothing when the user cancels. */
  onDone: (message?: string) => void
}

// Like official 2.1.303's "Save dynamic workflow" dialog: Tab toggles Project/User scope,
// Enter saves, a name collision asks for a second Enter to overwrite.
export function SaveDynamicWorkflowDialog({ script, defaultName, onDone }: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const [name, setName] = useState(defaultName)
  const [cursorOffset, setCursorOffset] = useState(defaultName.length)
  const [scope, setScope] = useState<WorkflowSaveScope>('project')
  const [saving, setSaving] = useState(false)
  const [existingPath, setExistingPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const cancel = useCallback(() => onDone(), [onDone])
  // Settings context: escape cancels, but 'n' stays typeable in the name field.
  useKeybinding('confirm:no', cancel, { context: 'Settings' })

  const handleChange = (value: string) => {
    setName(value)
    setExistingPath(null)
    setError(null)
  }

  const handleSubmit = () => {
    const trimmed = name.trim()
    if (saving || !trimmed) return
    setSaving(true)
    setError(null)
    saveDynamicWorkflow({ name: trimmed, scope, script, overwrite: existingPath !== null, cwd: getCwd() })
      .then(saved => {
        onDone(`Dynamic workflow saved to ${saved.path}. Invoke as /${saved.name} or Workflow({name: "${saved.name}"}) in future sessions.`)
      })
      .catch((caught: unknown) => {
        const message = errorMessage(caught)
        if (message.includes(WORKFLOW_SAVE_OVERWRITE_HINT)) {
          setExistingPath(message.match(/at (.+?)\. /)?.[1] ?? '(unknown path)')
        } else {
          setError(message)
        }
        setSaving(false)
      })
  }

  const handleKeyDown = (e: { key: string; preventDefault: () => void }) => {
    if (e.key === 'tab') {
      e.preventDefault()
      setScope(current => (current === 'project' ? 'user' : 'project'))
      setExistingPath(null)
      setError(null)
    }
  }

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title="Save dynamic workflow"
        subtitle={
          <Text dimColor>
            {scope === 'project' ? 'Project' : 'User'} scope · {workflowSavePathPreview(name, scope)}
          </Text>
        }
        onCancel={cancel}
        color="permission"
        isCancelActive={false}
        inputGuide={() => (
          <Byline>
            <KeyboardShortcutHint shortcut="enter" action={existingPath ? 'overwrite' : 'save'} />
            <KeyboardShortcutHint shortcut="tab" action="toggle scope" />
            <KeyboardShortcutHint shortcut="escape" action="cancel" />
          </Byline>
        )}
      >
        <Box flexDirection="column">
          <Text>Save as:</Text>
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Text>{'>'}</Text>
            <TextInput
              value={name}
              onChange={handleChange}
              onSubmit={handleSubmit}
              focus={!saving}
              showCursor={!saving}
              columns={columns}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
            />
          </Box>
          {existingPath && (
            <Box marginTop={1}>
              <Text color="warning">{existingPath} already exists. Press Enter again to overwrite, or change the name.</Text>
            </Box>
          )}
          {error && (
            <Box marginTop={1}>
              <Text color="error">{error}</Text>
            </Box>
          )}
          {saving && (
            <Box marginTop={1}>
              <Text dimColor>Saving…</Text>
            </Box>
          )}
        </Box>
      </Dialog>
    </Box>
  )
}
