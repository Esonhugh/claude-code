import { expect, test } from 'bun:test'
import { createUserMessage, normalizeMessages } from '../messages.js'
import { toolResultMeta, toSDKMessages } from './mappers.js'

function toolResult(id: string) {
  return {
    type: 'tool_result' as const,
    tool_use_id: id,
    content: 'Error: denied',
    is_error: true,
  }
}

test('tool_result_meta matches official 2.1.311 for a refused call', () => {
  const message = createUserMessage({
    content: [toolResult('toolu_1')],
    toolDenialKind: 'user-rejected',
    userFeedback: 'use ls instead',
    permissionDecision: { decision: 'reject', source: 'user_reject' },
  })
  expect(toolResultMeta(message)).toEqual([
    {
      id: 'toolu_1',
      non_execution_kind: 'user-rejected',
      user_feedback: 'use ls instead',
      permission_decision: { decision: 'reject', source: 'user_reject' },
    },
  ])
  // Subagent messages carry only the permission decision.
  expect(toolResultMeta(message, true)).toEqual([
    {
      id: 'toolu_1',
      permission_decision: { decision: 'reject', source: 'user_reject' },
    },
  ])
  expect(toSDKMessages([message])[0]).toMatchObject({
    tool_result_meta: toolResultMeta(message),
  })
})

test('tool_result_meta is omitted without metadata or a single tool_result', () => {
  const allowed = createUserMessage({
    content: [toolResult('toolu_1')],
    permissionDecision: {
      decision: 'accept',
      source: 'config',
      reasonType: 'rule',
    },
  })
  expect(toolResultMeta(allowed)).toEqual([
    {
      id: 'toolu_1',
      permission_decision: {
        decision: 'accept',
        source: 'config',
        reason_type: 'rule',
      },
    },
  ])
  expect(
    toolResultMeta(createUserMessage({ content: [toolResult('toolu_1')] })),
  ).toEqual([])
  expect(
    toolResultMeta(
      createUserMessage({
        content: [toolResult('toolu_1'), toolResult('toolu_2')],
        toolDenialKind: 'cancelled',
      }),
    ),
  ).toEqual([])
  expect(
    toSDKMessages([createUserMessage({ content: 'hi' })])[0],
  ).not.toHaveProperty('tool_result_meta')
})

test('normalizeMessages keeps the metadata on the tool_result block only', () => {
  const [result, text] = normalizeMessages([
    createUserMessage({
      content: [toolResult('toolu_1'), { type: 'text', text: 'note' }],
      toolDenialKind: 'permission-rule',
      permissionDecision: { decision: 'reject', source: 'config' },
    }),
  ])
  expect(result).toMatchObject({
    toolDenialKind: 'permission-rule',
    permissionDecision: { decision: 'reject', source: 'config' },
  })
  expect(text).toMatchObject({
    toolDenialKind: undefined,
    permissionDecision: undefined,
  })
})
