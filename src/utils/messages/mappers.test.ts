import { expect, test } from 'bun:test'
import { createSystemMessage, createUserMessage, normalizeMessages } from '../messages.js'
import { hookSystemMessageToSDK, toolResultMeta, toSDKMessages, toSDKSystemNotice } from './mappers.js'

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

// Shapes read from official 2.1.329 stream-json output.
test('an informational line is sent to SDK hosts as system/informational', () => {
  const message = createSystemMessage('heads up', 'warning', 'toolu_1')
  expect(toSDKSystemNotice(message)).toEqual({
    type: 'system',
    subtype: 'informational',
    content: 'heads up',
    level: 'warning',
    tool_use_id: 'toolu_1',
    uuid: message.uuid,
    session_id: expect.any(String),
  })
})

test('a prompt blocked by a UserPromptSubmit hook reports its outcome', () => {
  const message = {
    ...createSystemMessage('blocked\n\nOriginal prompt: hello', 'warning', undefined, true),
    promptSubmitEnding: { ending: { kind: 'blocked_by_hook' as const, reason: 'UPS_BLOCK' }, promptKept: false },
  }
  expect(toSDKSystemNotice(message)).toMatchObject({
    subtype: 'informational',
    level: 'warning',
    prevent_continuation: true,
    prompt_submit_outcome: { kind: 'blocked_by_hook', prompt_kept: false, reason: 'UPS_BLOCK' },
  })
})

test('a switch to the fallback model is sent as system/model_fallback', () => {
  const message = {
    ...createSystemMessage('Switched to Sonnet 5.5 due to high demand for Opus 5.5', 'warning'),
    modelFallback: { trigger: 'overloaded' as const, originalModel: 'claude-opus-5-5', fallbackModel: 'claude-sonnet-5-5' },
  }
  expect(toSDKSystemNotice(message)).toEqual({
    type: 'system',
    subtype: 'model_fallback',
    trigger: 'overloaded',
    original_model: 'claude-opus-5-5',
    fallback_model: 'claude-sonnet-5-5',
    content: 'Switched to Sonnet 5.5 due to high demand for Opus 5.5',
    uuid: message.uuid,
    session_id: expect.any(String),
  })
})

test("a hook's systemMessage is sent as a notice naming the hook", () => {
  const uuid = '00000000-0000-4000-8000-000000000001'
  expect(
    hookSystemMessageToSDK(
      { type: 'hook_system_message', content: 'SYS_MSG_X', hookName: 'PreToolUse:Bash', toolUseID: 'toolu_1', hookEvent: 'PreToolUse' },
      uuid,
    ),
  ).toEqual({
    type: 'system',
    subtype: 'informational',
    content: 'PreToolUse:Bash says: SYS_MSG_X',
    level: 'notice',
    uuid,
    session_id: expect.any(String),
  })
})
