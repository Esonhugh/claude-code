import * as React from 'react'
import { useCallback } from 'react'
import { Select } from '../../../components/CustomSelect/select.js'
import { Box, Text } from '../../../ink.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import type { SDKControlSSHPermissionUpdate } from '../../../entrypoints/sdk/controlTypes.js'
import {
  applyPermissionUpdate,
  persistPermissionUpdate,
} from '../../../utils/permissions/PermissionUpdate.js'
import { isManagedSSHRemoteRuntime } from '../../../ssh/managedSSHPermissions.js'
import { Dialog } from '../../design-system/Dialog.js'

type Props = {
  directoryPath: string
  onRemove: () => void
  onCancel: () => void
  permissionContext: ToolPermissionContext
  setPermissionContext: (context: ToolPermissionContext) => void
  isManagedSSHLocalUI?: boolean
  updateRemotePermissions?: (
    update: SDKControlSSHPermissionUpdate,
  ) => Promise<ToolPermissionContext | undefined>
}

export function RemoveWorkspaceDirectory({
  directoryPath,
  onRemove,
  onCancel,
  permissionContext,
  setPermissionContext,
  isManagedSSHLocalUI = false,
  updateRemotePermissions,
}: Props): React.ReactNode {
  const handleRemove = useCallback(() => {
    if (isManagedSSHLocalUI) {
      void updateRemotePermissions?.({
        type: 'removeDirectories',
        directories: [directoryPath],
      })
        .then(remoteContext => {
          if (remoteContext) setPermissionContext(remoteContext)
          onRemove()
        })
        .catch(() => {})
      return
    }

    const permissionUpdate = {
      type: 'removeDirectories' as const,
      directories: [directoryPath],
      destination: isManagedSSHRemoteRuntime() ? 'sshOverlay' as const : 'session' as const,
    }
    const updatedContext = applyPermissionUpdate(permissionContext, permissionUpdate)
    if (isManagedSSHRemoteRuntime()) {
      persistPermissionUpdate(permissionUpdate)
    }

    setPermissionContext(updatedContext)
    onRemove()
  }, [
    directoryPath,
    permissionContext,
    setPermissionContext,
    onRemove,
    isManagedSSHLocalUI,
    updateRemotePermissions,
  ])

  const handleSelect = useCallback(
    (value: string) => {
      if (value === 'yes') {
        handleRemove()
      } else {
        onCancel()
      }
    },
    [handleRemove, onCancel],
  )

  return (
    <Dialog
      title="Remove directory from workspace?"
      onCancel={onCancel}
      color="error"
    >
      <Box marginX={2} flexDirection="column">
        <Text bold>{directoryPath}</Text>
      </Box>
      <Text>
        Claude Code will no longer have access to files in this directory.
      </Text>
      <Select
        onChange={handleSelect}
        onCancel={onCancel}
        options={[
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ]}
      />
    </Dialog>
  )
}
