import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '../../types/message.js'

const configDir = mkdtempSync(join(tmpdir(), 'openai-reasoning-resume-'))
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
process.env.CLAUDE_CODE_USE_OPENAI = '1'
process.env.OPENAI_API_KEY = 'synthetic-reasoning-test-key'
process.env.CLAUDE_CODE_OPENAI_AUTH_MODE = 'api-key'
process.env.ANTHROPIC_API_KEY = 'synthetic-reasoning-test-key'
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }

try {
  const { createOpenAICompatClient } = await import('./openai-compat.js')
  const { assistantMessageToMessageParam, userMessageToMessageParam } = await import('./claude.js')
  const {
    createAssistantMessage,
    createUserMessage,
    isNotEmptyMessage,
    normalizeMessages,
    normalizeContentFromAPI,
    normalizeMessagesForAPI,
  } = await import('../../utils/messages.js')
  const { deserializeMessagesWithInterruptDetection } = await import('../../utils/conversationRecovery.js')
  const {
    flushSessionStorage,
    getTranscriptPath,
    loadTranscriptFile,
    recordTranscript,
    removeExtraFields,
  } = await import('../../utils/sessionStorage.js')

  const reasoning = {
    type: 'reasoning',
    id: 'rs_resume',
    summary: [],
    encrypted_content: 'synthetic-opaque-resume-state',
  }
  const requests: any[] = []
  let responseEvents: any[] = [
    { type: 'response.output_item.done', item: reasoning },
    { type: 'response.completed', response: { id: 'resp_resume', usage: { input_tokens: 1, output_tokens: 1 } } },
  ]
  globalThis.fetch = (async (_url, init) => {
    assert.equal(init?.method, 'POST')
    requests.push(JSON.parse(String(init?.body)))
    return new Response(
      responseEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  }) as typeof fetch
  const makeClient = () => createOpenAICompatClient({
    apiKey: 'synthetic-reasoning-test-key',
    maxRetries: 0,
    timeout: 1000,
  })
  const user = createUserMessage({ content: 'Start reasoning' })
  const stream = await makeClient().beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [userMessageToMessageParam(user, false, false)],
    stream: true,
  })
  const messages: Message[] = [user]
  const blocks = new Map<number, any>()
  let responseId = ''
  for await (const event of stream) {
    if (event.type === 'message_start') responseId = event.message.id
    if (event.type === 'content_block_start') blocks.set(event.index, event.content_block)
    if (event.type === 'content_block_stop') {
      const message = createAssistantMessage({
        content: normalizeContentFromAPI([blocks.get(event.index)], []),
      })
      message.message.id = responseId
      messages.push(message)
    }
  }
  assert.equal(messages.length, 2, 'opaque reasoning must produce a persistable message')
  await recordTranscript(messages)
  await flushSessionStorage()
  assert.ok(getTranscriptPath().startsWith(configDir))
  const transcript = await loadTranscriptFile(getTranscriptPath())
  const serialized = removeExtraFields(messages.map(message => transcript.messages.get(message.uuid)!))
  const restored = deserializeMessagesWithInterruptDetection(serialized).messages
  assert.ok(
    restored.some(message => message.uuid === messages[1]!.uuid),
    'completed OpenAI reasoning must survive resume even without a text/tool sibling',
  )

  const unresolvedTool = createAssistantMessage({ content: [
    { type: 'tool_use', id: 'fc_interrupted', name: 'Read', input: { file_path: 'test.txt' } },
  ] })
  unresolvedTool.message.id = responseId
  await recordTranscript([...messages, unresolvedTool])
  await flushSessionStorage()
  const interruptedTranscript = await loadTranscriptFile(getTranscriptPath())
  const interrupted = deserializeMessagesWithInterruptDetection(removeExtraFields(
    [...messages, unresolvedTool].map(message => interruptedTranscript.messages.get(message.uuid)!),
  ))
  assert.equal(
    interrupted.turnInterruptionState.kind,
    'interrupted_prompt',
    'preserved reasoning must not mark an interrupted tool call as a completed turn',
  )
  assert.ok(interrupted.messages.some(message => message.uuid === messages[1]!.uuid))

  const normalized = normalizeMessagesForAPI(restored)
  await makeClient().beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: normalized.map(message => message.message),
  } as any)
  assert.deepEqual(requests[1].input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Start reasoning' }] },
    reasoning,
  ])

  responseEvents = [
    { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'synthetic-compacted-state' } },
    { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]
  await (makeClient().beta.messages as any).compact({
    model: 'gpt-5.5',
    messages: normalized.map(message => message.message),
  })
  assert.deepEqual(requests[2].input, [...requests[1].input, { type: 'compaction_trigger' }])

  responseEvents = [
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_summary', delta: 'Visible summary' },
    { type: 'response.reasoning_summary_text.done', item_id: 'rs_summary', text: 'Visible summary' },
    { type: 'response.output_item.done', item: { ...reasoning, id: 'rs_summary' } },
    { type: 'response.output_text.delta', delta: 'Visible answer' },
    { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]
  const summarizedReply = await makeClient().beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [userMessageToMessageParam(user, false, false)],
  })
  const summarizedMessage = createAssistantMessage({ content: summarizedReply.content })
  const displayMessages = normalizeMessages([summarizedMessage]).filter(isNotEmptyMessage)
  assert.deepEqual(
    displayMessages.flatMap(message => message.message.content)
      .filter(block => block.type === 'thinking')
      .map(block => block.thinking),
    ['Visible summary'],
    'opaque state must not replace the last visible thinking block in the UI',
  )
  const summarizedBlocks = summarizedReply.content.map(block => {
    const message = createAssistantMessage({ content: [block] })
    message.message.id = summarizedReply.id
    return message
  })

  responseEvents.splice(-1, 0,
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_resume', call_id: 'fc_resume', name: 'Read' } },
    { type: 'response.function_call_arguments.done', item_id: 'fc_resume', arguments: '{"file_path":"test.txt"}' },
  )
  const toolReply = await makeClient().beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [userMessageToMessageParam(user, false, false)],
  })
  const toolHistory: Message[] = [user]
  // Persist each completed block separately, as the query loop does.
  for (const block of toolReply.content) {
    const message = createAssistantMessage({ content: [block] })
    message.message.id = toolReply.id
    toolHistory.push(message)
    await recordTranscript(toolHistory)
    await flushSessionStorage()
  }
  toolHistory.push(
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'fc_resume', content: 'file contents' }] }),
    createAssistantMessage({ content: 'Read complete.' }),
  )
  await recordTranscript(toolHistory)
  await flushSessionStorage()
  const toolTranscript = await loadTranscriptFile(getTranscriptPath())
  const toolRestored = deserializeMessagesWithInterruptDetection(removeExtraFields(
    toolHistory.map(message => toolTranscript.messages.get(message.uuid)!),
  )).messages
  const requestIndex = requests.length
  await makeClient().beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: normalizeMessagesForAPI(toolRestored).map(message => message.message),
  } as any)
  assert.deepEqual(requests[requestIndex].input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Start reasoning' }] },
    { ...reasoning, id: 'rs_summary' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Visible answer' }] },
    { type: 'function_call', id: 'fc_resume', call_id: 'fc_resume', name: 'Read', arguments: '{"file_path":"test.txt"}' },
    { type: 'function_call_output', call_id: 'fc_resume', output: 'file contents' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Read complete.' }] },
  ])

  // Switching providers must not send OpenAI metadata or an empty synthetic signature to Anthropic.
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  const switchedMessages = normalizeMessagesForAPI([
    ...restored,
    createUserMessage({ content: 'Continue on Anthropic' }),
  ]).map(message => message.type === 'assistant'
    ? assistantMessageToMessageParam(message, false, false)
    : message.message)
  assert.equal(JSON.stringify(switchedMessages).includes(reasoning.encrypted_content), false)
  const switchedSummary = normalizeMessagesForAPI([
    user,
    summarizedMessage,
    createUserMessage({ content: 'Continue on Anthropic' }),
  ]).find(message => message.type === 'assistant')!
  assert.deepEqual(assistantMessageToMessageParam(switchedSummary, false, false).content, [
    { type: 'text', text: 'Visible answer' },
  ])
  assert.deepEqual(
    normalizeMessagesForAPI([user, ...summarizedBlocks]).at(-1)?.message.content,
    [{ type: 'text', text: 'Visible answer' }],
    'split streaming summary and opaque blocks must also be excluded from Anthropic requests',
  )
  assert.equal(
    summarizedMessage.message.content.some(block => block.type === 'thinking' && block.thinking === 'Visible summary'),
    true,
    'provider conversion must not mutate the saved visible summary',
  )

  const nativeThinking = createAssistantMessage({ content: [
    { type: 'thinking', thinking: 'Native thinking', signature: 'native-signature' },
    { type: 'redacted_thinking', data: 'native-redacted' },
  ] })
  const nativeAnswer = createAssistantMessage({ content: 'Native answer' })
  nativeAnswer.message.id = nativeThinking.message.id
  await recordTranscript([user, nativeThinking, nativeAnswer])
  await flushSessionStorage()
  const nativeTranscript = await loadTranscriptFile(getTranscriptPath())
  const nativeSerialized = removeExtraFields(
    [user, nativeThinking, nativeAnswer].map(message => nativeTranscript.messages.get(message.uuid)!),
  )
  const nativeRestored = deserializeMessagesWithInterruptDetection(nativeSerialized).messages
  assert.deepEqual(
    normalizeMessagesForAPI(nativeRestored).find(message => message.type === 'assistant')?.message.content,
    [...nativeThinking.message.content, ...nativeAnswer.message.content],
  )
  assert.equal(
    deserializeMessagesWithInterruptDetection([user, nativeThinking]).messages.some(message => message.uuid === nativeThinking.uuid),
    false,
    'native orphan thinking cleanup must remain unchanged',
  )
  const nativeTrailingThinking = {
    ...nativeAnswer,
    message: {
      ...nativeAnswer.message,
      content: [...nativeAnswer.message.content, ...nativeThinking.message.content],
    },
  }
  assert.deepEqual(
    normalizeMessagesForAPI([user, nativeTrailingThinking]).at(-1)?.message.content,
    nativeAnswer.message.content,
    'native trailing thinking cleanup must remain unchanged',
  )
  console.log('openai-reasoning-resume.test.ts passed')
} finally {
  const { flushSessionStorage } = await import('../../utils/sessionStorage.js')
  const { resetGitFileWatcher } = await import('../../utils/git/gitFilesystem.js')
  await flushSessionStorage()
  resetGitFileWatcher()
  globalThis.fetch = originalFetch
  for (const name of Object.keys(process.env)) {
    if (!(name in originalEnv)) delete process.env[name]
  }
  Object.assign(process.env, originalEnv)
  rmSync(configDir, { recursive: true, force: true })
}
