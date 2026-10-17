import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { formatPluginNotice } from '../../services/mods/uiNoticeText.js'
import type { ModToolNotices } from '../../services/mods/uiNotice.js'

const noSubscription = () => () => {}

/** The `$.ui.notice` line under the question dialog of an open tool call. */
export function ModToolNoticeLine({ notices, toolUseID }: {
  notices: ModToolNotices | undefined
  toolUseID: string
}): React.ReactNode {
  const notice = React.useSyncExternalStore(
    notices?.subscribe ?? noSubscription,
    () => notices?.read(toolUseID),
  )
  if (notice === undefined) return null
  return (
    <Box height={1} justifyContent="flex-end">
      <Text color="inactive" dimColor>{formatPluginNotice(notice.plugin, notice.text)}</Text>
    </Box>
  )
}
