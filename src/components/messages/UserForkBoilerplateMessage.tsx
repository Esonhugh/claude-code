import * as React from 'react'
import { FORK_GLYPH } from '../../constants/figures.js'
import { Box, Text } from '../../ink.js'

type Props = {
  addMargin: boolean
  directive: string
}

export function UserForkBoilerplateMessage({ addMargin, directive }: Props): React.JSX.Element {
  return (
    <Box marginTop={addMargin ? 1 : 0} backgroundColor="userMessageBackground" paddingRight={1}>
      <Text aria-label="fork:" dimColor>{FORK_GLYPH}</Text>
      <Box paddingLeft={1}><Text>{directive}</Text></Box>
    </Box>
  )
}
