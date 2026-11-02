import { describe, expect, it } from 'bun:test'
import { detectLang, translate } from './i18n'
import en from './locales/en.json'
import zhHans from './locales/zh-Hans.json'
import zhHant from './locales/zh-Hant.json'
import {
  addUserMessage,
  initialState,
  permissionResponse,
  reduce,
  unsupportedControlResponse,
} from './protocol'

const ev = (event: Record<string, unknown>) => ({ type: 'stream_event', event })

function fold(messages: unknown[]) {
  return messages.reduce(reduce, addUserMessage(initialState, 'hi'))
}

describe('reduce', () => {
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

  it('shows a failed result as an error', () => {
    const state = fold([
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] },
    ])
    expect(state.busy).toBe(false)
    expect(state.items.at(-1)).toMatchObject({ kind: 'error', text: 'boom' })
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
    expect(translate('en', 'approvalTitle', { tool: 'Bash' })).toBe('Allow Bash?')
  })
})
