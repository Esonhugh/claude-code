import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { isCommandPluginSource } from '../../utils/plugins/commandSource.js'
import type { PluginMarketplaceEntry } from '../../utils/plugins/schemas.js'

/**
 * Shows the command a `command` plugin source runs. Installing from a view
 * that renders this counts as the user reviewing that command.
 */
export function CommandSourceNotice({
  entry,
}: {
  entry: PluginMarketplaceEntry
}): React.ReactNode {
  if (!isCommandPluginSource(entry.source)) return null
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="warning">
        Installing runs this command on your computer (
        {entry.source.mode === 'link'
          ? 'its output directory is linked in place'
          : 'its output directory is copied'}
        ):
      </Text>
      <Text> {entry.source.command}</Text>
    </Box>
  )
}
