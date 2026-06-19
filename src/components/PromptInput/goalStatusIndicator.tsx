import * as React from 'react'

import { Text } from '../../ink.js'

export function GoalStatusIndicator({
  active,
}: {
  active: boolean
}): React.ReactNode {
  if (!active) return null
  return (
    <Text color="warning" bold>
      Goal is set
    </Text>
  )
}
