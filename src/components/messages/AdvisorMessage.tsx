import figures from 'figures'
import React from 'react'
import { Box, Text } from '../../ink.js'
import { logEvent } from '../../services/analytics/index.js'
import {
  type AdvisorBlock,
  getAdvisorErrorCode,
  getAdvisorRefusalText,
  isAdvisorRefusal,
} from '../../utils/advisor.js'
import { renderModelName } from '../../utils/model/model.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { MessageResponse } from '../MessageResponse.js'
import { ToolUseLoader } from '../ToolUseLoader.js'

// tool_use_ids whose unknown advisor content was already reported.
const reportedUnknownContent = new Set<string>()

type Props = {
  block: AdvisorBlock
  addMargin: boolean
  resolvedToolUseIDs: Set<string>
  erroredToolUseIDs: Set<string>
  shouldAnimate: boolean
  verbose: boolean
  advisorModel?: string
}

export function AdvisorMessage({
  block,
  addMargin,
  resolvedToolUseIDs,
  erroredToolUseIDs,
  shouldAnimate,
  verbose,
  advisorModel,
}: Props): React.ReactNode {
  if (block.type === 'server_tool_use') {
    const input =
      block.input && Object.keys(block.input).length > 0
        ? jsonStringify(block.input)
        : null
    return (
      <Box marginTop={addMargin ? 1 : 0} paddingRight={2} flexDirection="row">
        <ToolUseLoader
          shouldAnimate={shouldAnimate}
          isUnresolved={!resolvedToolUseIDs.has(block.id)}
          isError={erroredToolUseIDs.has(block.id)}
        />
        <Text bold>Advising</Text>
        {advisorModel ? (
          <Text dimColor> using {renderModelName(advisorModel)}</Text>
        ) : null}
        {input ? <Text dimColor> · {input}</Text> : null}
      </Box>
    )
  }

  let body: React.ReactNode
  if (isAdvisorRefusal(block)) {
    const reason = getAdvisorRefusalText(block)
    const line = (
      <Text>
        <Text color="warning">Advisor declined to advise on this request</Text>
        {reason !== undefined && !verbose ? (
          <>
            {' '}
            <CtrlOToExpand />
          </>
        ) : null}
      </Text>
    )
    body =
      verbose && reason !== undefined ? (
        <Box flexDirection="column">
          {line}
          <Text dimColor>{reason}</Text>
        </Box>
      ) : (
        line
      )
  } else {
    const content = block.content as { type?: string } | null | undefined
    switch (content?.type) {
      case 'advisor_tool_result_error':
        body = (
          <Text color="error">
            Advisor unavailable ({getAdvisorErrorCode(block)})
          </Text>
        )
        break
      case 'advisor_result':
        body = verbose ? (
          <Text dimColor>{(block.content as { text: string }).text}</Text>
        ) : (
          <Text dimColor>
            {figures.tick} Advisor has reviewed the conversation and will
            apply the feedback <CtrlOToExpand />
          </Text>
        )
        break
      case 'advisor_redacted_result':
        body = (
          <Text dimColor>
            {figures.tick} Advisor has reviewed the conversation and will
            apply the feedback
          </Text>
        )
        break
      default:
        if (content != null && !reportedUnknownContent.has(block.tool_use_id)) {
          reportedUnknownContent.add(block.tool_use_id)
          logEvent('tengu_advisor_unknown_content', {})
        }
        return null
    }
  }

  return (
    <Box paddingRight={2}>
      <MessageResponse>{body}</MessageResponse>
    </Box>
  )
}
