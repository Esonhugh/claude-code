import type { ThinkingBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import { Box, NoSelect, Text } from '../../ink.js'
import { cleanAssistantDisplayText } from '../../utils/assistantDisplayText.js'
import { shouldHideAssistantSummaryHint } from '../../utils/model/assistantSummaryDisplay.js'
import { Markdown } from '../Markdown.js'
import { ModsRender } from '../ModsRender.js'

type Props = { param: ThinkingBlockParam; model: string; messageId: string; addMargin: boolean; shouldShowDot: boolean }

export function AssistantSummaryMessage(props: Props): React.ReactNode {
  const text = props.param.thinking.trim()
  const input = React.useMemo(() => ({
    surface: 'terminal' as const,
    component: 'AssistantMessage' as const,
    requestId: props.messageId,
    props: { text: cleanAssistantDisplayText(text), isFirstOfReply: props.shouldShowDot, isSummary: true as const },
  }), [text, props.messageId, props.shouldShowDot])
  return <ModsRender input={input}>{next => <NativeAssistantSummary
    text={next.text === input.props.text ? text : next.text as string}
    model={props.model} addMargin={props.addMargin} shouldShowDot={next.isFirstOfReply as boolean}
  />}</ModsRender>
}

function NativeAssistantSummary({ text, model, addMargin, shouldShowDot }: {
  text: string; model: string; addMargin: boolean; shouldShowDot: boolean
}): React.ReactNode {
  // The native renderer captures this at mount; later capability refreshes do not relabel history.
  const [hideHint] = React.useState(() => shouldHideAssistantSummaryHint(model))
  if (text.trim() === '') return null
  return <Box flexDirection="row" marginTop={addMargin ? 1 : 0} width="100%">
    {shouldShowDot && <NoSelect fromLeftEdge minWidth={2}><Text color="text">{BLACK_CIRCLE}</Text></NoSelect>}
    <Box flexDirection="column" flexGrow={1}>
      <Markdown hint={hideHint ? undefined : 'summary'} capProseWidth stripPromptTags={false}>{cleanAssistantDisplayText(text)}</Markdown>
    </Box>
  </Box>
}
