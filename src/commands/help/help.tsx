import * as React from 'react'
import { HelpV2 } from '../../components/HelpV2/HelpV2.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (
  onDone,
  { options: { commands }, mods },
) => {
  return <HelpV2 commands={commands} mods={mods?.commands} onClose={onDone} />
}
