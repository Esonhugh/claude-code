import { describe, expect, it } from 'bun:test'
import { detectLang, translate } from './i18n'
import en from './locales/en.json'
import zhHans from './locales/zh-Hans.json'
import zhHant from './locales/zh-Hant.json'
import {
  addUserMessage,
  answerApproval,
  currentTodos,
  hookBlock,
  type Item,
  rewindTo,
  startRecap,
  initialState,
  permissionResponse,
  queueUserMessage,
  reduce,
  unsupportedControlResponse,
} from './protocol'

const ev = (event: Record<string, unknown>) => ({ type: 'stream_event', event })

function fold(messages: unknown[]) {
  return messages.reduce(reduce, addUserMessage(initialState, 'hi'))
}

describe('reduce', () => {
  it('queues a message sent mid-turn and moves it in when the engine echoes it', () => {
    const asst = (id: string, text: string) => ({
      type: 'assistant',
      message: { id, role: 'assistant', content: [{ type: 'text', text }] },
    })
    let state = addUserMessage(initialState, 'first', [], 'u1')
    state = reduce(state, asst('m1', 'working'))
    state = queueUserMessage(state, 'also check B', 'u2')
    expect(state.queued.map(q => q.text)).toEqual(['also check B'])
    expect(state.items.map(i => i.kind)).toEqual(['user', 'assistant'])
    // Fed in between tool calls: a queued_command replay with the same uuid.
    state = reduce(state, { type: 'user', isReplay: true, uuid: 'u2', message: { role: 'user', content: 'also check B' } })
    expect(state.queued).toEqual([])
    expect(state.items.map(i => (i.kind === 'user' ? i.text : i.kind))).toEqual(['first', 'assistant', 'also check B'])
    expect(state.busy).toBe(true)
  })

  it('does not repeat a reply the transcript already gave when a reopened page gets it again', () => {
    // Written while no tab was attached: on disk (the loaded history) and in the lines held for the next tab.
    const thinking = { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } }
    const text = { type: 'assistant', uuid: 'a2', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'PARIS' }] } }
    let state = fold([thinking, text])
    state = [thinking, text].reduce(reduce, state)
    const reply = state.items.at(-1)
    expect(reply?.kind === 'assistant' && reply.blocks.map(b => b.kind)).toEqual(['thinking', 'text'])
  })

  it('shows a channel message as who sent it and from where, not as the raw tag', () => {
    let state = addUserMessage(initialState, 'hi', [], 'u1')
    state = reduce(state, {
      type: 'user',
      isReplay: true,
      uuid: 'c1',
      message: { role: 'user', content: '<channel source="plugin:fakechat:fakechat" chat_id="1" user="a &amp; b">\n<b>hi</b> & "you"\n</channel>' },
    })
    expect(state.items.at(-1)).toEqual({ kind: 'channel', id: 'c1', source: 'fakechat', user: 'a & b', text: '<b>hi</b> & "you"' })
    // The engine escapes a closing tag inside the text (`<\\/channel>`); the page shows what was sent.
    state = reduce(state, {
      type: 'user',
      isReplay: true,
      uuid: 'c2',
      message: { role: 'user', content: '<channel source="plugin:fakechat:fakechat">\nsee <\\/channel> and ＜\\/ Channel>\n</channel>' },
    })
    expect(state.items.at(-1)).toMatchObject({ kind: 'channel', text: 'see </channel> and ＜/ Channel>' })
    // A prompt that only mentions the tag is the person's own message.
    state = reduce(state, { type: 'user', isReplay: true, uuid: 'u2', message: { role: 'user', content: 'what does <channel source="x"> mean?' } })
    expect(state.items.at(-1)).toMatchObject({ kind: 'user', text: 'what does <channel source="x"> mean?' })
  })

  it('runs a queued message the turn did not take as the next turn', () => {
    let state = addUserMessage(initialState, 'first', [], 'u1')
    state = queueUserMessage(state, 'later', 'u2')
    state = reduce(state, { type: 'result', subtype: 'success', is_error: false, result: 'ok' })
    expect(state.busy).toBe(true)
    expect(state.queued).toEqual([])
    expect(state.items.at(-1)).toMatchObject({ kind: 'user', id: 'u2', text: 'later' })
    // The next turn streams its reply before the engine echoes the prompt.
    state = reduce(state, { type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'answer' }] } })
    state = reduce(state, { type: 'user', isReplay: true, uuid: 'u2', message: { role: 'user', content: 'later' } })
    expect(state.items.map(i => i.kind)).toEqual(['user', 'user', 'assistant'])
  })

  it('streams text deltas into one assistant message and ends the turn on result', () => {
    const state = fold([
      { type: 'system', subtype: 'init', model: 'claude-opus-5-5', cwd: '/w' },
      ev({ type: 'message_start', message: { id: 'm1', model: 'claude-opus-5-5' } }),
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
      {
        type: 'assistant',
        message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Hello' }] },
      },
      { type: 'result', subtype: 'success', is_error: false, result: 'Hello' },
    ])
    expect(state.busy).toBe(false)
    expect(state.cwd).toBe('/w')
    expect(state.items).toEqual([
      { kind: 'user', id: 'user-0', text: 'hi' },
      {
        kind: 'assistant',
        id: 'm1',
        model: 'claude-opus-5-5',
        streamed: true,
        blocks: [{ kind: 'text', text: 'Hello' }],
      },
    ])
  })

  it('keeps tool input and attaches the tool result', () => {
    const state = fold([
      ev({ type: 'message_start', message: { id: 'm1' } }),
      ev({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      }),
      ev({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":' },
      }),
      ev({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"ls"}' },
      }),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }] }],
        },
      },
    ])
    expect(state.items[1]).toMatchObject({
      blocks: [{ kind: 'tool', id: 't1', name: 'Bash', input: '{"command":"ls"}', result: 'a.txt', isError: false }],
    })
  })

  it('builds messages without partial events and ignores subagent traffic', () => {
    const state = fold([
      {
        type: 'assistant',
        parent_tool_use_id: 'agent-1',
        message: { id: 'sub', content: [{ type: 'text', text: 'inner' }] },
      },
      {
        type: 'assistant',
        message: {
          id: 'm2',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'done' },
          ],
        },
      },
      { type: 'unknown_future_type' },
    ])
    expect(state.items).toHaveLength(2)
    expect(state.items[1]).toMatchObject({
      id: 'm2',
      streamed: false,
      blocks: [
        { kind: 'thinking', text: 'hmm' },
        { kind: 'text', text: 'done' },
      ],
    })
  })

  it('takes a reloaded thinking time from thinking_ms', () => {
    const state = fold([
      { type: 'assistant', thinking_ms: 4200, message: { id: 'm3', content: [{ type: 'thinking', thinking: 'hmm' }] } },
    ])
    expect(state.items.find(i => i.kind === 'assistant')).toMatchObject({ blocks: [{ kind: 'thinking', text: 'hmm', ms: 4200 }] })
  })

  it('shows a failed result as an error', () => {
    const state = fold([
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] },
    ])
    expect(state.busy).toBe(false)
    expect(state.items.at(-1)).toMatchObject({ kind: 'error', text: 'boom' })
  })

  it('shows a synthetic API error once, as an error without a model', () => {
    const text = 'API Error: 500 {"type":"error"}'
    const state = fold([
      {
        type: 'assistant',
        error: 'unknown',
        message: { id: 'e1', model: '<synthetic>', content: [{ type: 'text', text }] },
      },
      { type: 'result', subtype: 'success', is_error: true, result: text },
    ])
    expect(state.items.slice(1)).toEqual([{ kind: 'error', id: 'e1', text }])
    expect(state.busy).toBe(false)
  })

  it('treats a transcript API error message as an error too', () => {
    const state = fold([
      {
        type: 'assistant',
        isApiErrorMessage: true,
        message: { id: 'e2', model: '<synthetic>', content: [{ type: 'text', text: 'Prompt is too long' }] },
      },
    ])
    expect(state.items.at(-1)).toEqual({ kind: 'error', id: 'e2', text: 'Prompt is too long' })
  })

  it('shows local command output as a system line, not as the user', () => {
    const state = fold([
      {
        type: 'user',
        isReplay: true,
        uuid: 'u1',
        message: { role: 'user', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>' },
      },
      {
        type: 'user',
        isReplay: true,
        uuid: 'u2',
        message: { role: 'user', content: '<local-command-stdout>Set model to Sonnet 5.5</local-command-stdout>' },
      },
      {
        type: 'user',
        isReplay: true,
        uuid: 'u3',
        message: { role: 'user', content: '<local-command-stderr>Unknown model</local-command-stderr>' },
      },
      {
        type: 'assistant',
        uuid: 'u4',
        message: { id: 'a4', model: '<synthetic>', content: [{ type: 'text', text: 'Total cost: $0.00' }] },
      },
    ])
    expect(state.items.slice(1)).toEqual([
      { kind: 'user', id: 'u1', text: '/model sonnet' },
      { kind: 'local', id: 'u2', text: 'Set model to Sonnet 5.5' },
      { kind: 'local', id: 'u3', text: 'Unknown model', isError: true },
      { kind: 'local', id: 'a4', text: 'Total cost: $0.00' },
    ])
  })

  it('records the session environment from init, initialize and get_settings', () => {
    const state = fold([
      {
        type: 'system',
        subtype: 'init',
        claude_code_version: '2.1.296',
        mcp_servers: [{ name: 'zotero', status: 'connected' }, { name: 'x', status: 'failed' }],
        skills: ['pdf', 'docx'],
        plugins: [{ name: 'p1', path: '/p1' }],
        apiKeySource: 'ANTHROPIC_API_KEY',
      },
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'web-init-1',
          response: {
            models: [{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Most capable', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }],
            account: { email: 'a@b.c', subscriptionType: 'max' },
          },
        },
      },
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'web-settings-2',
          response: {
            effective: { uiName: 'Claw', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'say hi' }] }] } },
            applied: { model: 'claude-opus-5-5', effort: 'high' },
          },
        },
      },
    ])
    expect(state.models[0]).toEqual({
      value: 'opus',
      displayName: 'Opus 5.5',
      resolvedModel: 'claude-opus-5-5',
      description: 'Most capable',
      effortLevels: ['low', 'high'],
    })
    expect(state.effort).toBe('high')
    expect(state.env).toEqual({
      version: '2.1.296',
      mcpServers: [{ name: 'zotero', status: 'connected' }, { name: 'x', status: 'failed' }],
      skills: ['pdf', 'docx'],
      plugins: [{ name: 'p1', path: '/p1' }],
      apiKeySource: 'ANTHROPIC_API_KEY',
      account: { email: 'a@b.c', subscriptionType: 'max' },
      uiName: 'Claw',
      hooks: [{ event: 'Stop', matcher: '', command: 'say hi' }],
      planMode: false,
    })
  })

  it('takes the model from the settings answer over the replayed init', () => {
    // A page that reattaches gets the session's first init again; the model picked since is in `applied`.
    const state = fold([
      { type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5', cwd: '/w' },
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'web-settings-1',
          response: { effective: {}, applied: { model: 'claude-haiku-5-5', effort: 'high' } },
        },
      },
    ])
    expect(state.model).toBe('claude-haiku-5-5')
    expect(state.env.planMode).toBe(false)
    const allowed = reduce(state, {
      type: 'control_response',
      response: { subtype: 'success', request_id: 'web-settings-2', response: { effective: { planModeAvailable: true }, applied: {} } },
    })
    expect(allowed.env.planMode).toBe(true)
  })

  it('keeps the enabled ChatGPT apps from the codex_apps answer', () => {
    const state = fold([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'web-apps-1',
          response: {
            eligible: true,
            apps: [
              { connectorId: 'c1', name: 'Gmail', mentionName: 'gmail', tools: 3, enabled: true },
              { connectorId: 'c2', name: 'Slack', mentionName: 'slack', tools: 2, enabled: false },
            ],
          },
        },
      },
    ])
    expect(state.env.codexApps).toEqual([{ mention: 'gmail', name: 'Gmail', description: undefined }])
  })

  it('queues permission requests and answers them in the control format', () => {
    const state = fold([
      {
        type: 'control_request',
        request_id: 'r1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
      },
    ])
    expect(state.approvals).toEqual([
      { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, suggestions: [] },
    ])
    expect(permissionResponse(state.approvals[0]!, 'allow')).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'r1',
        response: { behavior: 'allow', updatedInput: { command: 'ls' } },
      },
    })
    expect(permissionResponse(state.approvals[0]!, 'deny')).toMatchObject({
      response: { response: { behavior: 'deny' } },
    })
  })

  it('keeps a background worker\'s request when the turn that started it ends', () => {
    const ask = (id: string, agent?: string) => ({
      type: 'control_request',
      request_id: id,
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, ...(agent && { agent_id: agent }) },
    })
    const state = fold([ask('r1'), ask('r2', 'a1'), { type: 'result', subtype: 'success', is_error: false }])
    expect(state.approvals.map(a => [a.requestId, a.agentId])).toEqual([['r2', 'a1']])
  })

  it('sends the offered rules with "always allow"', () => {
    const rule = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'localSettings' }
    const state = fold([
      {
        type: 'control_request',
        request_id: 'r2',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, permission_suggestions: [rule] },
      },
    ])
    expect(permissionResponse(state.approvals[0]!, 'always')).toMatchObject({
      response: { response: { behavior: 'allow', updatedPermissions: [rule] } },
    })
  })

  it('records models, context usage, mode changes and cost', () => {
    const state = fold([
      { type: 'system', subtype: 'init', model: 'claude-opus-5-5', permissionMode: 'default' },
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'web-init-1',
          response: { models: [{ value: 'default', displayName: 'Default' }, { value: 'sonnet', displayName: 'Sonnet' }] },
        },
      },
      { type: 'control_response', response: { subtype: 'success', request_id: 'web-mode-2', response: { mode: 'plan' } } },
      { type: 'control_response', response: { subtype: 'error', request_id: 'web-model-3', error: 'bad model' } },
      { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.25 },
      { type: 'control_response', response: { subtype: 'success', request_id: 'web-context-4', response: { percentUsed: 12.5 } } },
    ])
    expect(state.models).toEqual([
      { value: 'default', displayName: 'Default' },
      { value: 'sonnet', displayName: 'Sonnet' },
    ])
    expect(state.permissionMode).toBe('plan')
    expect(state.notice).toBe('bad model')
    expect(state.costUsd).toBe(0.25)
    expect(state.contextPercent).toBe(12.5)
  })

  it('records slash commands from initialize and terminal-only ones from init', () => {
    const state = fold([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'web-init-1',
          response: {
            commands: [
              { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost'] },
              { name: 'color', description: 'Set the prompt bar color', argumentHint: '[red|blue]' },
              { description: 'no name' },
            ],
          },
        },
      },
      { type: 'system', subtype: 'init', terminal_slash_commands: ['color'] },
    ])
    expect(state.commands).toEqual([
      { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost'] },
      { name: 'color', description: 'Set the prompt bar color', argumentHint: '[red|blue]' },
    ])
    expect(state.terminalCommands).toEqual(['color'])
  })

  it('answers control requests the page does not handle with an error', () => {
    expect(
      unsupportedControlResponse({
        type: 'control_request',
        request_id: 'e1',
        request: { subtype: 'elicitation' },
      }),
    ).toMatchObject({ response: { subtype: 'error', request_id: 'e1' } })
    expect(
      unsupportedControlResponse({
        type: 'control_request',
        request_id: 'r1',
        request: { subtype: 'can_use_tool' },
      }),
    ).toBeUndefined()
  })
})

describe('conversation extras', () => {
  it('measures how long the model thought while it streamed', () => {
    const state = fold([
      ev({ type: 'message_start', message: { id: 'm1' } }),
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    ])
    const block = (state.items[1] as { blocks: { startedAt?: number }[] }).blocks[0]!
    block.startedAt = Date.now() - 6_200
    const done = reduce(state, ev({ type: 'content_block_stop', index: 0 }))
    const ms = (done.items[1] as { blocks: { ms?: number }[] }).blocks[0]!.ms!
    expect(Math.round(ms / 1000)).toBe(6)
  })

  it('keeps the patch of a file edit result on its tool block', () => {
    const state = fold([
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/a' } }] } },
      {
        type: 'user',
        tool_use_result: { type: 'update', originalFile: 'big', structuredPatch: [{ oldStart: 1, lines: [] }] },
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      },
    ])
    expect((state.items[1] as { blocks: unknown[] }).blocks[0]).toMatchObject({
      result: 'ok',
      meta: { type: 'update', structuredPatch: [{ oldStart: 1, lines: [] }] },
    })
    expect(JSON.stringify(state)).not.toContain('big')
  })

  it('marks a compaction and puts its summary under it instead of a bubble', () => {
    const state = fold([
      { type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: '2026-11-02T10:42:00Z', compact_metadata: { trigger: 'auto', pre_tokens: 186000, post_tokens: 12000 } },
      { type: 'user', isReplay: true, uuid: 's1', message: { content: 'This session is being continued from a previous conversation. Done: X.' } },
    ])
    expect(state.items.slice(1)).toEqual([
      {
        kind: 'compact',
        id: 'c1',
        trigger: 'auto',
        preTokens: 186000,
        postTokens: 12000,
        at: Date.parse('2026-11-02T10:42:00Z'),
        summary: 'This session is being continued from a previous conversation. Done: X.',
      },
    ])
  })

  it('lets the compaction mark stand for a typed /compact and its output', () => {
    const sent = addUserMessage(fold([{ type: 'result', subtype: 'success' }]), '/compact', undefined, 'u1')
    const state = [
      { type: 'system', subtype: 'compact_boundary', uuid: 'c1', compact_metadata: { trigger: 'manual', pre_tokens: 12000 } },
      { type: 'assistant', message: { id: 'l1', model: '<synthetic>', content: [{ type: 'text', text: 'Compacted' }] } },
    ].reduce(reduce, sent)
    expect(state.items.slice(1).map(i => i.kind)).toEqual(['compact'])
  })

  it('lets the mark stand for the /compact a reloaded transcript has after it', () => {
    const state = fold([
      { type: 'user', uuid: 'q', isReplay: true, message: { role: 'user', content: 'question' } },
      { type: 'system', subtype: 'compact_boundary', uuid: 'c1', compact_metadata: { trigger: 'manual' } },
      { type: 'user', uuid: 's', isReplay: true, isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation. S' } },
      { type: 'user', uuid: 'cmd', isReplay: true, message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>' } },
      { type: 'user', uuid: 'out', isReplay: true, message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' } },
      { type: 'user', uuid: 'next', isReplay: true, message: { role: 'user', content: 'after' } },
    ])
    expect(state.items.map(i => i.kind)).toEqual(['user', 'user', 'compact', 'user'])
    expect(state.items.at(-1)).toMatchObject({ id: 'next', text: 'after' })
  })

  it('turns the answer to /recap into a ※ line', () => {
    const sent = startRecap(fold([{ type: 'result', subtype: 'success' }]), 18)
    expect(sent.busy).toBe(true)
    const auto = reduce(sent, { type: 'assistant', message: { id: 'r1', model: '<synthetic>', content: [{ type: 'text', text: 'Reviewing a paper.' }] } })
    expect(auto.items.at(-1)).toEqual({ kind: 'recap', id: 'r1', text: 'Reviewing a paper.', away: 18 })
    expect(auto.recapPending).toBeUndefined()
    // Typed by hand (or replayed from the transcript): the `/recap` bubble goes.
    const typed = [
      { type: 'user', isReplay: true, uuid: 'u2', message: { content: '<command-name>/recap</command-name>' } },
      { type: 'user', isReplay: true, uuid: 'u3', message: { content: '<local-command-stdout>Reviewing.</local-command-stdout>' } },
    ].reduce(reduce, initialState)
    expect(typed.items).toEqual([{ kind: 'recap', id: 'u3', text: 'Reviewing.' }])
    // Other local output stays a ⎿ line.
    const other = reduce(initialState, { type: 'assistant', message: { id: 'l1', model: '<synthetic>', content: [{ type: 'text', text: 'Set model' }] } })
    expect(other.items).toEqual([{ kind: 'local', id: 'l1', text: 'Set model' }])
  })

  it('follows the goal and adds a divider when it ends', () => {
    const goal = (g: Record<string, unknown>, uuid: string) => ({ type: 'system', subtype: 'goal_state_changed', uuid, goal: { type: 'goal_status', id: 'g', condition: 'tests pass', ...g } })
    let state = fold([goal({ status: 'active', iterations: 0, setAt: 5 }, 'g0')])
    expect(state.goal).toEqual({ condition: 'tests pass', status: 'active', iterations: 0, setAt: 5, checks: [] })
    state = reduce(state, goal({ status: 'active', iterations: 1, reason: 'lint fails' }, 'g1'))
    state = reduce(state, goal({ status: 'active', iterations: 2, reason: 'lint fails' }, 'g2'))
    expect(state.goal).toMatchObject({ iterations: 2, checks: ['lint fails'] })
    state = reduce(state, goal({ status: 'met', iterations: 3, durationMs: 60_000 }, 'g3'))
    expect(state.goal).toBeUndefined()
    expect(state.items.at(-1)).toEqual({ kind: 'goal', id: 'g3', status: 'met', iterations: 3, durationMs: 60_000 })
  })

  it('follows a goal set or cleared from this page, which -p does not stream', () => {
    const set = addUserMessage(initialState, '/goal tests pass', undefined, 'u1')
    expect(set.goal).toMatchObject({ condition: 'tests pass', status: 'active', iterations: 0, checks: [] })
    const cleared = addUserMessage({ ...set, busy: false }, '/goal clear', undefined, 'u2')
    expect(cleared.goal).toBeUndefined()
    expect(cleared.items.at(-1)).toEqual({ kind: 'goal', id: 'goal-u2', status: 'cleared', iterations: 0 })
    // `/goal` alone only shows the goal.
    expect(addUserMessage(set, '/goal', undefined, 'u3').goal).toBe(set.goal)
  })

  it('remembers the answer to an approval by its tool use id', () => {
    const state = fold([
      {
        type: 'control_request',
        request_id: 'r1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          tool_use_id: 't9',
          input: { command: 'npm test' },
          permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] }],
        },
      },
    ])
    expect(state.approvals[0]?.toolUseId).toBe('t9')
    const always = answerApproval(state, state.approvals[0]!, 'always')
    expect(always.approvals).toEqual([])
    expect(always.decisions).toEqual({ t9: { toolName: 'Bash', choice: 'always', rules: 'Bash(npm test:*)' } })
    expect(answerApproval(state, state.approvals[0]!, 'deny').decisions.t9).toEqual({ toolName: 'Bash', choice: 'deny' })
  })

  it('groups get_context_usage into the meter rows', () => {
    const state = fold([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'web-context-1',
          response: {
            totalTokens: 76000,
            maxTokens: 200000,
            percentage: 38,
            isAutoCompactEnabled: true,
            autoCompactThreshold: 187000,
            categories: [
              { id: 'system_prompt', name: 'System prompt', tokens: 9000 },
              { id: 'memory_files', name: 'Memory files', tokens: 3000 },
              { id: 'system_tools', name: 'System tools', tokens: 12000 },
              { id: 'mcp_tools', name: 'MCP tools', tokens: 4000 },
              { id: 'mcp_tools_deferred', name: 'MCP tools (deferred)', tokens: 999, isDeferred: true },
              { id: 'messages', name: 'Messages', tokens: 48000 },
              { id: 'free_space', name: 'Free space', tokens: 111000 },
            ],
          },
        },
      },
    ])
    expect(state.contextPercent).toBe(38)
    expect(state.context).toEqual({
      total: 76000,
      max: 200000,
      percent: 38,
      system: 12000,
      tools: 16000,
      messages: 48000,
      autoCompact: true,
      threshold: 187000,
    })
  })

  it('keeps the latest rate limit per window', () => {
    const state = fold([
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1_800_000_000 } },
    ])
    expect(state.rateLimits.five_hour).toEqual({ type: 'five_hour', utilization: 0.42, resetsAt: 1_800_000_000 })
  })

  it('reads the todo list of the latest TodoWrite call', () => {
    const todo = (id: string, todos: unknown) => ({ kind: 'tool' as const, id, name: 'TodoWrite', input: JSON.stringify({ todos }) })
    const items: Item[] = [
      { kind: 'assistant', id: 'a1', streamed: false, blocks: [todo('t1', [{ content: 'old', status: 'pending' }])] },
      {
        kind: 'assistant',
        id: 'a2',
        streamed: false,
        blocks: [
          todo('t2', [
            { content: 'Read', status: 'completed', activeForm: 'Reading' },
            { content: 'Write', status: 'in_progress', activeForm: 'Writing' },
          ]),
          { kind: 'tool', id: 't3', name: 'TodoWrite', input: '{"todos": [' },
        ],
      },
    ]
    expect(currentTodos(items)).toEqual([
      { content: 'Read', status: 'completed', activeForm: 'Reading' },
      { content: 'Write', status: 'in_progress', activeForm: 'Writing' },
    ])
    expect(currentTodos([])).toEqual([])
  })

  it('builds the todo list from TaskCreate and TaskUpdate calls', () => {
    const tool = (id: string, name: string, input: unknown, result?: string, isError?: boolean) => ({
      kind: 'tool' as const,
      id,
      name,
      input: JSON.stringify(input),
      ...(result !== undefined && { result }),
      ...(isError && { isError }),
    })
    const items: Item[] = [
      {
        kind: 'assistant',
        id: 'a1',
        streamed: false,
        blocks: [
          tool('t1', 'TaskCreate', { subject: 'Read', activeForm: 'Reading' }, 'Task #1 created successfully: Read'),
          tool('t2', 'TaskCreate', { subject: 'Write' }, 'Task #2 created successfully: Write'),
          tool('t3', 'TaskCreate', { subject: 'Ship' }, 'Task #3 created successfully: Ship'),
          tool('t4', 'TaskUpdate', { taskId: '1', status: 'completed' }, 'ok'),
          tool('t5', 'TaskUpdate', { taskId: '2', status: 'in_progress', activeForm: 'Writing' }, 'ok'),
          tool('t6', 'TaskUpdate', { taskId: '3', status: 'deleted' }, 'ok'),
          tool('t7', 'TaskUpdate', { taskId: '2', status: 'completed' }, 'no such task', true),
        ],
      },
    ]
    expect(currentTodos(items)).toEqual([
      { content: 'Read', status: 'completed', activeForm: 'Reading' },
      { content: 'Write', status: 'in_progress', activeForm: 'Writing' },
    ])
  })

  it('drops a rewound prompt and what followed, leaving a note', () => {
    const state = fold([{ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'a' }] } }])
    const next = addUserMessage(state, 'again', undefined, 'u2')
    expect(rewindTo(next, 'u2', 'Rewound').items.map(i => i.kind)).toEqual(['user', 'assistant', 'note'])
    expect(rewindTo(next, 'missing', 'x')).toBe(next)
  })

  it('keeps the rewind points the engine lists, and drops the rewound ones', () => {
    const state = fold([
      { type: 'control_response', response: { subtype: 'success', request_id: 'web-rwpoints-1', response: { uuids: ['u1', 'u2', 7] } } },
    ])
    expect(state.rewindPoints).toEqual(['u1', 'u2'])
    const next = addUserMessage(addUserMessage({ ...state, notice: "Couldn't rewind: stale_target" }, 'one', undefined, 'u1'), 'two', undefined, 'u2')
    const rewound = rewindTo(next, 'u2', 'Rewound')
    expect(rewound.rewindPoints).toEqual(['u1'])
    expect(rewound.notice).toBeUndefined()
  })
})

describe('i18n', () => {
  it('picks the language from navigator.languages', () => {
    expect(detectLang(['zh-TW'])).toBe('zh-Hant')
    expect(detectLang(['zh-Hant-HK'])).toBe('zh-Hant')
    expect(detectLang(['zh-HK'])).toBe('zh-Hant')
    expect(detectLang(['zh-CN'])).toBe('zh-Hans')
    expect(detectLang(['zh'])).toBe('zh-Hans')
    expect(detectLang(['fr-FR', 'zh-CN'])).toBe('zh-Hans')
    expect(detectLang(['en-US'])).toBe('en')
    expect(detectLang([])).toBe('en')
  })

  it('keeps the three locale files on the same keys', () => {
    const keys = Object.keys(en).sort()
    expect(Object.keys(zhHans).sort()).toEqual(keys)
    expect(Object.keys(zhHant).sort()).toEqual(keys)
  })

  it('fills placeholders', () => {
    expect(translate('en', 'wantsToUse', { tool: 'Bash' })).toBe('Claude wants to use Bash')
  })

  it('uses the singular form for a count of one', () => {
    expect(translate('en', 'waitingTasks', { n: '1' })).toBe('· waiting on 1 task')
    expect(translate('en', 'waitingTasks', { n: '2' })).toBe('· waiting on 2 tasks')
    expect(translate('zh-Hans', 'taskCount', { n: '1' })).toBe(translate('zh-Hans', 'taskCount', { n: '2' }).replace('2', '1'))
  })
})

describe('interrupts and session info', () => {
  it('shows hook outcomes, peer messages, scheduled tasks and mod log lines as the TUI does', () => {
    const hook = (rest: Record<string, unknown>) => ({ type: 'system', subtype: 'hook_response', hook_id: 'h', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', output: '', stdout: '', stderr: '', outcome: 'success', ...rest })
    let state = reduce(initialState, hook({ uuid: 'h1', hook_event: 'UserPromptSubmit', hook_name: 'UserPromptSubmit', exit_code: 2, outcome: 'error', stderr: 'no secrets\nmore' }))
    // A PreToolUse block is the tool's error result; the tool card shows it.
    state = reduce(state, hook({ uuid: 'h0', exit_code: 2, outcome: 'error', stderr: 'rm is not allowed' }))
    state = reduce(state, hook({ uuid: 'h2', exit_code: 1, outcome: 'error' }))
    state = reduce(state, hook({ uuid: 'h3', hook_event: 'PostToolUse', hook_name: 'PostToolUse:Bash', stdout: JSON.stringify({ decision: 'block', reason: 'no network' }) }))
    state = reduce(state, hook({ uuid: 'h4', stdout: JSON.stringify({ systemMessage: 'lint ran' }) }))
    // Quiet successes and Stop hooks (the TUI sums those up elsewhere) add nothing.
    state = reduce(state, hook({ uuid: 'h5', exit_code: 0 }))
    state = reduce(state, hook({ uuid: 'h6', hook_event: 'Stop', hook_name: 'Stop', exit_code: 2, outcome: 'error' }))
    state = reduce(state, { type: 'system', subtype: 'scheduled_task_fire', uuid: 'c1' })
    state = reduce(state, { type: 'system', subtype: 'ui_log', plugin: 'agents-md', text: 'loaded 2 files', uuid: 'l1' })
    state = reduce(state, {
      type: 'user',
      isReplay: true,
      isSynthetic: true,
      uuid: 'p1',
      message: { role: 'user', content: '<cross-session-message from="uds:/tmp/a.sock" from-name="reviewer">\nlooks good\n</cross-session-message>' },
    })
    // As a reloaded transcript keeps it, with the line the model reads first.
    state = reduce(state, {
      type: 'user',
      isReplay: true,
      uuid: 'p3',
      message: { role: 'user', content: 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/b.sock" from-name="ws" from-mode="prompting">\nmerged\n</cross-session-message>\nThis came from another Claude session.' },
    })
    // A sibling worker's SendMessage, as the receiving worker's transcript has it.
    state = reduce(state, {
      type: 'user',
      isReplay: true,
      uuid: 'p4',
      message: { role: 'user', content: 'Another Claude session sent a message:\n<agent-message from="a16415e97117c9160">\nPONG-FROM-BOB\n</agent-message>\n\nThat "other Claude session" is an agent working inside this same session.' },
    })
    // A cron prompt is meta: not shown as something the user typed.
    state = reduce(state, { type: 'user', isReplay: true, isSynthetic: true, uuid: 'p2', message: { role: 'user', content: 'check the build' } })
    expect(state.items.map(i => (i.kind === 'event' ? [i.key, i.vars.why ?? i.vars.text ?? '', i.tone ?? ''] : [i.kind, i.kind === 'peer' ? `${i.from}:${i.text}` : '']))).toEqual([
      ['hookBlockedWhy', 'no secrets', 'error'],
      ['hookError', '', 'error'],
      ['hookBlockedWhy', 'no network', 'error'],
      ['hookSays', 'lint ran', ''],
      ['cronFired', '', ''],
      ['modLog', 'loaded 2 files', ''],
      ['peer', 'reviewer:looks good'],
      ['peer', 'ws:merged'],
      ['peer', 'a16415e97117c9160:PONG-FROM-BOB'],
    ])
    // A reloaded firing keeps the time it fired, not the time of the reload.
    const at = '2026-11-03T14:05:00.000Z'
    const fired = reduce(initialState, { type: 'system', subtype: 'scheduled_task_fire', uuid: 'c2', timestamp: at }).items[0]
    expect(fired?.kind === 'event' && fired.vars.time).toBe(new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
    expect(hookBlock('PreToolUse:Bash hook error: [/x/guard.sh]: rm is not allowed\n')).toEqual({ hook: 'PreToolUse:Bash', why: 'rm is not allowed' })
    expect(hookBlock('PreToolUse:Write hook error: Blocked by hook')).toEqual({ hook: 'PreToolUse:Write', why: 'Blocked by hook' })
    expect(hookBlock('Exit code 1')).toBeUndefined()
  })

  it('shows an API retry until the next reply starts', () => {
    const busy = { ...initialState, busy: true }
    const retrying = reduce(busy, { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 5000, error_status: 529, error: 'overloaded', uuid: 'r1' })
    expect(retrying.retry).toMatchObject({ attempt: 2, max: 10, delayMs: 5000, status: 529 })
    expect(reduce(retrying, { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', model: 'x' } } }).retry).toBeUndefined()
    expect(reduce(retrying, { type: 'result', subtype: 'success' }).retry).toBeUndefined()
  })

  it('marks a stopped turn as interrupted, not with its internal diagnostic', () => {
    const busy = { ...initialState, busy: true }
    const stopped = reduce(busy, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
    })
    expect(stopped.busy).toBe(false)
    expect(stopped.items).toEqual([{ kind: 'note', id: 'interrupted-0', text: '', key: 'interrupted' }])
    const failed = reduce(busy, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null', 'Boom'],
    })
    expect(failed.items.map(i => (i.kind === 'error' ? i.text : ''))).toEqual(['Boom'])
  })

  it('shows an interrupt in a reloaded transcript as a note, not as something the user typed', () => {
    for (const text of ['[Request interrupted by user]', '[Request interrupted by user for tool use]']) {
      const state = reduce(initialState, { type: 'user', isReplay: true, uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text }] } })
      expect(state.items).toEqual([{ kind: 'note', id: 'u1', text: '', key: 'interrupted' }])
    }
  })

  it('counts installed plugins without the built-in mods', () => {
    const state = reduce(initialState, {
      type: 'system',
      subtype: 'init',
      plugins: [
        { name: 'agents-md', path: '/x', source: 'agents-md@builtin' },
        { name: 'mine', path: '/y', source: 'mine@market' },
      ],
    })
    expect(state.env.plugins?.map(p => p.name)).toEqual(['mine'])
  })
})
