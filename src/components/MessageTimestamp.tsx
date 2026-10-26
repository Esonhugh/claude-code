import React from 'react'
import { stringWidth } from '../ink/stringWidth.js'
import { Box, Text } from '../ink.js'
import type { NormalizedMessage } from '../types/message.js'
import { formatClockTime } from '../utils/timeFormat.js'

type Props = {
  message: NormalizedMessage
  isTranscriptMode: boolean
}

export function MessageTimestamp({
  message,
  isTranscriptMode,
}: Props): React.ReactNode {
  const shouldShowTimestamp =
    isTranscriptMode &&
    message.timestamp &&
    message.type === 'assistant' &&
    message.message.content.some(c => c.type === 'text')

  if (!shouldShowTimestamp) {
    return null
  }

  const date = new Date(message.timestamp)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const formattedTimestamp = formatClockTime(date)

  return (
    <Box minWidth={stringWidth(formattedTimestamp)}>
      <Text dimColor>{formattedTimestamp}</Text>
    </Box>
  )
}
