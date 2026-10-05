import * as React from 'react'
import { PRIORITIES } from '../../context/notifications.js'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'

export function PinnedNotifications(): React.ReactNode {
  const pinned = useAppState(state => state.notifications.pinned)
  if (pinned.length === 0) return null

  return (
    <Box flexDirection="column" paddingX={2}>
      {pinned.slice().sort((a, b) => PRIORITIES[a.priority] - PRIORITIES[b.priority]).map(notice => (
        <Text key={notice.key} color={notice.color ?? 'warning'} wrap={notice.wrap ? 'wrap' : 'truncate'}>
          {'⚠ '}{'jsx' in notice ? notice.jsx : notice.text}
        </Text>
      ))}
    </Box>
  )
}
