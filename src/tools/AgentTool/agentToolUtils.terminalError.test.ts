import { expect, test } from 'bun:test'

// Loads the Agent tool first, as the app does; agentToolUtils alone hits an init-order cycle.
import './AgentTool.js'
import { createAssistantAPIErrorMessage, createAssistantMessage } from '../../utils/messages.js'
import { getAgentTerminalError } from './agentToolUtils.js'

test('a run that ended on an API error fails with the official termination text', () => {
  const apiError = {
    ...createAssistantAPIErrorMessage({ content: 'API Error: 400 probe failure', error: 'invalid_request' }),
    apiErrorStatus: 400,
    requestId: 'req_1',
  }
  const error = getAgentTerminalError([createAssistantMessage({ content: 'working' }), apiError], 'claude-opus-5-5')
  expect(error?.message).toBe(
    'Agent terminated early due to an API error: API Error: 400 probe failure (error type invalid_request, HTTP 400, request id req_1, model sent to the API: claude-opus-5-5)',
  )
})

test('a run whose last reply is not an error has no terminal error', () => {
  expect(getAgentTerminalError([createAssistantMessage({ content: 'done' })], 'claude-opus-5-5')).toBeUndefined()
})
