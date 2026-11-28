import { describe, expect, it } from 'bun:test'
import { initialState, reduce, type Block } from './protocol'
import { selectedTmuxTool, tmuxCall } from './tmux'

const tool = (id: string, input: object, result?: string): Extract<Block, { kind: 'tool' }> => ({
  kind: 'tool', id, name: 'Tmux', input: JSON.stringify(input), result,
})

describe('Tmux transcript details', () => {
  it('selects the exact tool use and tool name in the active session, not the last result for a target', () => {
    const capture = tool('read-a', { action: 'capture-pane', target: 'pane-a' }, '{"text":"old line"}')
    const newer = tool('read-b', { action: 'capture-pane', target: 'pane-a' }, '{"text":"new line"}')
    const items = [{ kind: 'assistant' as const, id: 'a1', streamed: false, blocks: [capture, newer, { ...capture, id: 'bash', name: 'Bash' }] }]
    expect(selectedTmuxTool('s1', items, { sessionId: 's1', toolUseId: 'read-a' })).toBe(capture)
    expect(selectedTmuxTool('s1', items, { sessionId: 's1', toolUseId: 'read-b' })).toBe(newer)
    expect(selectedTmuxTool('s1', items, { sessionId: 's1', toolUseId: 'bash' })).toBeUndefined()
    expect(selectedTmuxTool('s2', items, { sessionId: 's1', toolUseId: 'read-a' })).toBeUndefined()
    expect(selectedTmuxTool('s1', [], { sessionId: 's1', toolUseId: 'read-a' })).toBeUndefined()
  })

  it('reflects the result that arrives for the already selected tool use', () => {
    const selection = { sessionId: 's1', toolUseId: 'read-a' }
    const before = reduce(initialState, {
      type: 'assistant', message: { id: 'm1', content: [
        { type: 'tool_use', name: 'Tmux', id: 'read-a', input: { action: 'capture-pane', target: 'pane-a' } },
      ] },
    })
    expect(tmuxCall(selectedTmuxTool('s1', before.items, selection)!).status).toBe('pending')
    const result = JSON.stringify({ mode: 'compact', target: 'pane-a', text: 'after\nupdate' })
    const after = reduce(before, {
      type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-a', content: result }] },
    })
    expect(tmuxCall(selectedTmuxTool('s1', after.items, selection)!)).toMatchObject({ status: 'returned', snapshot: 'after\nupdate', json: result })
  })

  it('shows the new session id and multiline initial preview, without changing the actual JSON', () => {
    for (const id of [{ target: 'pane-a' }, { sessionId: 'pane-a' }]) {
      const result = JSON.stringify({ ...id, preview: '\u001b[31m  A <tag>\u001b[0m\r\n\r\nB\tC\n', pid: 42 })
      const opened = tool('open', { action: 'new-session', command: 'sh' }, result)
      expect(tmuxCall(opened)).toMatchObject({ action: 'new-session', target: 'pane-a', status: 'returned', snapshot: '  A <tag>\n\nB\tC\n', json: result })
    }
  })

  it('shows only the returned text/preview for captures, across output modes and the historical alias', () => {
    for (const output of [{ mode: 'full', text: 'first\nsecond' }, { mode: 'save_file', preview: 'first\nsecond', filePath: '/tmp/not-read' }]) {
      const capture = { ...tool('cap', { action: 'capture-pane', target: 'pane-a' }, JSON.stringify(output)), name: 'Terminal' }
      expect(tmuxCall(capture)).toMatchObject({ action: 'capture-pane', target: 'pane-a', snapshot: 'first\nsecond' })
    }
  })

  it('does not treat accepted input as a snapshot or completed command', () => {
    const write = tool('send', { action: 'send-keys', target: 'pane-a', text: 'not output' }, '{"accepted":true,"text":"not a snapshot"}')
    expect(tmuxCall(write)).toMatchObject({ status: 'sent', snapshot: undefined, json: write.result })
    expect(tmuxCall(tool('outstanding', { action: 'send-keys' })).status).toBe('pending')
  })

  it('uses the received string for a one-line summary and preserves safe multiline input for details', () => {
    const input = { action: 'send-keys', target: 'pane-a', text: '\x1b[32mecho <tag>\x1b[0m\r\n  next\tpart\x07\u202e', enter: false }
    expect(tmuxCall(tool('send', input, '{"accepted":true}'))).toMatchObject({
      inputSummary: 'echo <tag>', sentInput: { text: 'echo <tag>\n  next\tpart', keys: [] }, snapshot: undefined,
    })
  })

  it('summarizes the actual special key and appends Enter only when requested, in handler order', () => {
    for (const [input, inputSummary, keys] of [
      [{ key: 'CTRL_C' }, 'Ctrl+C', ['Ctrl+C']],
      [{ key: 'LEFT', enter: false }, 'Left', ['Left']],
      [{ enter: true }, 'Enter', ['Enter']],
      [{ text: 'ls -la', enter: true }, 'ls -la · Enter', ['Enter']],
      [{ text: 'ls -la', key: 'TAB', enter: true }, 'ls -la · Tab · Enter', ['Tab', 'Enter']],
      [{ key: 'ENTER', enter: true }, 'Enter · Enter', ['Enter', 'Enter']],
    ] as const) {
      expect(tmuxCall(tool('send', { action: 'send-keys', ...input }))).toMatchObject({ inputSummary, sentInput: { keys } })
    }
  })

  it('does not infer input from legacy results or from fields the handler does not send', () => {
    const input = { action: 'send-keys', target: 'pane-a' }
    for (const extra of [{}, { text: '', key: 'FORGED', keys: ['TAB'], enter: 'true' }]) {
      const write = tmuxCall(tool('old', { ...input, ...extra }, '{"accepted":true,"text":"not input"}'))
      expect(write.target).toBe('pane-a')
      expect(write.sentInput).toBeUndefined()
      expect(write.inputSummary).toBeUndefined()
    }
    expect(tmuxCall(tool('read', { action: 'capture-pane', text: 'not input', enter: true })).sentInput).toBeUndefined()
  })

  it('keeps structured and unstructured failures, and old non-JSON results readable', () => {
    const input = { action: 'capture-pane', target: 'missing' }
    const failure = '{"error":{"code":"SESSION_NOT_FOUND","message":"Unknown PTY session"},"text":"not a snapshot"}'
    expect(tmuxCall(tool('bad', input, failure))).toMatchObject({ status: 'failed', snapshot: undefined, text: 'Unknown PTY session', json: failure })
    expect(tmuxCall({ ...tool('hook', input, 'Denied\r\nby hook'), isError: true })).toMatchObject({ status: 'failed', text: 'Denied\nby hook', json: undefined })
    expect(tmuxCall(tool('old', input, 'legacy: line A\nline B'))).toMatchObject({ status: 'returned', text: 'legacy: line A\nline B', snapshot: undefined })
    expect(tmuxCall({ ...tool('partial', {}), input: '{' })).toMatchObject({ action: undefined, target: undefined, status: 'pending' })
  })
})
