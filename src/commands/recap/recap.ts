import { getSystemPrompt } from '../../constants/prompts.js'
import { getSystemContext, getUserContext } from '../../context.js'
import { generateAwaySummary } from '../../services/awaySummary.js'
import type {
  LocalCommandCall,
  LocalJSXCommandContext,
} from '../../types/command.js'
import type { Message } from '../../types/message.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

function stripInProgressAssistantMessage(messages: Message[]): Message[] {
  const last = messages.at(-1)
  if (last?.type === 'assistant' && last.message.stop_reason === null) {
    return messages.slice(0, -1)
  }
  return messages
}

// No turn has finished in this process yet (e.g. right after --resume):
// rebuild the fork params from the command context, as /btw does.
async function buildFallbackParams(
  context: LocalJSXCommandContext,
): Promise<CacheSafeParams | null> {
  const forkContextMessages = getMessagesAfterCompactBoundary(
    stripInProgressAssistantMessage(context.messages),
  )
  if (forkContextMessages.length === 0) return null
  const [rawSystemPrompt, userContext, systemContext] = await Promise.all([
    getSystemPrompt(
      context.options.tools,
      context.options.mainLoopModel,
      [],
      context.options.mcpClients,
    ),
    getUserContext(),
    getSystemContext(),
  ])
  return {
    systemPrompt: asSystemPrompt(rawSystemPrompt),
    userContext,
    systemContext,
    toolUseContext: context,
    forkContextMessages,
  }
}

export const call: LocalCommandCall = async (_args, context) => {
  const result = await generateAwaySummary(
    context.abortController.signal,
    () => buildFallbackParams(context),
  )
  switch (result.kind) {
    case 'ok':
    case 'api-error':
      return { type: 'text', value: result.text }
    case 'no-turn':
      return {
        type: 'text',
        value: 'Nothing to recap yet \u2014 send a message first.',
      }
    case 'aborted':
      return { type: 'text', value: 'Recap cancelled.' }
    case 'failed':
      return {
        type: 'text',
        value: "Couldn't generate a recap. Run with --debug for details.",
      }
  }
}
