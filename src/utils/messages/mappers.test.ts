import { expect, test } from 'bun:test'
import { createAttachmentMessage } from '../attachments.js'
import { createCompactBoundaryMessage, createSystemMessage, createUserMessage, normalizeMessages } from '../messages.js'
import { hookSystemMessagesToSDK, hookSystemMessageToSDK, toolResultMeta, toSDKMessages, toSDKSystemNotice } from './mappers.js'

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

test('the line before a refusal nothing is tried after is sent as system/model_refusal_no_fallback', () => {
  const message = {
    ...createSystemMessage('', 'info'),
    modelRefusalNoFallback: {
      originalModel: 'claude-opus-5-5',
      requestId: null,
      category: 'cyber',
      explanation: 'fake refusal',
      refusedUserMessageUuid: '00000000-0000-4000-8000-000000000002',
    },
  }
  expect(toSDKSystemNotice(message)).toEqual({
    type: 'system',
    subtype: 'model_refusal_no_fallback',
    original_model: 'claude-opus-5-5',
    request_id: null,
    api_refusal_category: 'cyber',
    api_refusal_explanation: 'fake refusal',
    refused_user_message_uuid: '00000000-0000-4000-8000-000000000002',
    content: '',
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

// Official 2.1.329 prefixes every line and drops ANSI codes and control characters.
test("each line of a hook's systemMessage names the hook", () => {
  const uuid = '00000000-0000-4000-8000-000000000001'
  expect(
    hookSystemMessageToSDK(
      { type: 'hook_system_message', content: 'line1\nline2\r\nline3\u001b[31mred\u0007', hookName: 'PreToolUse:Bash', toolUseID: 'toolu_1', hookEvent: 'PreToolUse' },
      uuid,
    ).content,
  ).toBe('PreToolUse:Bash says: line1\nPreToolUse:Bash says: line2\nPreToolUse:Bash says: line3red ')
})

// A UserPromptSubmit hook's systemMessage is among the prompt's own messages,
// not the query loop's; official sends it after system/init.
test("a prompt's hook messages are sent, except the ones a compaction kept", () => {
  const hook = (content: string) =>
    createAttachmentMessage({ type: 'hook_system_message', content, hookName: 'UserPromptSubmit', toolUseID: 'toolu_1', hookEvent: 'UserPromptSubmit' })
  const kept = hook('old')
  const fresh = hook('new')
  const boundary = {
    ...createCompactBoundaryMessage('manual', 100),
    compactMetadata: { trigger: 'manual' as const, preTokens: 100, preservedMessages: { anchorUuid: kept.uuid, uuids: [kept.uuid] } },
  }
  expect(hookSystemMessagesToSDK([createUserMessage({ content: 'hi' }), fresh]).map(m => [m.uuid, m.content])).toEqual([
    [fresh.uuid, 'UserPromptSubmit says: new'],
  ])
  expect(hookSystemMessagesToSDK([boundary, kept, fresh]).map(m => m.uuid)).toEqual([fresh.uuid])
})
