import figures from 'figures'
import React from 'react'
import { CtrlOToExpand } from '../../components/CtrlOToExpand.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { renderModelName } from '../../utils/model/model.js'
import type { Output } from './AdvisorTool.js'

/** Mirrors the server-side advisor result line; the advice itself shows in verbose mode. */
export function renderToolResultMessage(
  { advice, model }: Output,
  _progress: unknown,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  return (
    <MessageResponse>
      {verbose ? (
        <Text dimColor>{advice}</Text>
      ) : (
        <Text dimColor>
          {figures.tick} Advisor ({renderModelName(model)}) has reviewed the
          conversation and will apply the feedback <CtrlOToExpand />
        </Text>
      )}
    </MessageResponse>
  )
}
