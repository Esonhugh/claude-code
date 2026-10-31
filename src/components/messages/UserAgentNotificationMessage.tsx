import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import { Box, Text, type TextProps } from '../../ink.js'
import { MONITOR_EVENT_TAG } from '../../tools/MonitorTool/monitorEvents.js'
import { formatDuration } from '../../utils/format.js'
import { extractTag } from '../../utils/messages.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
}

function getStatusColor(status: string | null): TextProps['color'] {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'killed':
      return 'warning'
    default:
      return 'text'
  }
}

export function UserAgentNotificationMessage({
  addMargin,
  param: { text },
}: Props): React.ReactNode {
  const summary = extractTag(text, 'summary')
  if (!summary) return null

  const status = extractTag(text, 'status')
  const color = getStatusColor(status)
  // Monitor events lead with the first output line, like official 2.1.303.
  const monitorDescription = summary.match(/^Monitor event: "(.*)"$/s)?.[1]
  const firstEventLine = extractTag(text, MONITOR_EVENT_TAG)
    ?.split('\n')
    .find(line => line.trim())
  const label =
    monitorDescription !== undefined && firstEventLine
      ? `Monitor event: ${firstEventLine} · ${monitorDescription}`
      : summary
  const durationMs = Number(extractTag(text, 'duration_ms'))

  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text>
        <Text color={color}>{BLACK_CIRCLE}</Text> {label}
        {Number.isFinite(durationMs) && durationMs > 0 && (
          <Text dimColor> · {formatDuration(durationMs)}</Text>
        )}
      </Text>
    </Box>
  )
}
