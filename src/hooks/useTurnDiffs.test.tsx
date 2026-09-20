import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import React from 'react'
import render from '../ink/root.js'
import type { Message, UserMessage } from '../types/message.js'
import { useTurnDiffs, type TurnDiff } from './useTurnDiffs.js'

function user(content: UserMessage['message']['content']): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content },
  }
}

async function inspect(
  messages: Message[],
  check: (turns: TurnDiff[]) => void,
) {
  let observed: TurnDiff[] = []
  function Capture() {
    observed = useTurnDiffs(messages)
    return null
  }
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  const instance = await render(<Capture />, {
    stdout: stdout as NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  try {
    await Bun.sleep(20)
    check(observed)
  } finally {
    instance.unmount()
    instance.cleanup()
  }
}

test('turn diffs keep real totals while limiting file bodies to 400 lines', async () => {
  const edit = user('')
  edit.message.content = [
    { type: 'tool_result', tool_use_id: 'edit', content: 'ok' },
  ]
  edit.toolUseResult = {
    filePath: '/fixture/large.txt',
    type: 'create',
    structuredPatch: [],
    content: Array.from({ length: 700 }, (_, i) => `line ${i}`).join('\n'),
  }
  await inspect([user('make a file'), edit], turns => {
    const file = turns[0]!.files.get('/fixture/large.txt')!
    expect(file.linesAdded).toBe(700)
    expect(file.hunks.flatMap(hunk => hunk.lines)).toHaveLength(400)
    expect(file.isTruncated).toBe(true)
    expect(turns[0]!.stats.linesAdded).toBe(700)
  })
})

test('turn previews preserve ordinary text blocks and failed edits are excluded', async () => {
  const failed = user([
    {
      type: 'tool_result',
      tool_use_id: 'failed',
      content: 'denied',
      is_error: true,
    },
  ])
  failed.toolUseResult = {
    filePath: '/fixture/denied.txt',
    type: 'create',
    structuredPatch: [],
    content: 'not written',
  }
  const edited = user([
    { type: 'tool_result', tool_use_id: 'ok', content: 'ok' },
  ])
  edited.toolUseResult = {
    filePath: '/fixture/ok.txt',
    type: 'create',
    structuredPatch: [],
    content: 'written',
  }
  await inspect(
    [user([{ type: 'text', text: 'explain this change' }]), failed, edited],
    turns => {
      expect(turns[0]!.userPromptPreview).toBe('explain this change')
      expect([...turns[0]!.files.keys()]).toEqual(['/fixture/ok.txt'])
    },
  )
})

test('turn previews count Unicode code points rather than splitting surrogate pairs', async () => {
  const edit = user([
    { type: 'tool_result', tool_use_id: 'ok', content: 'ok' },
  ])
  edit.toolUseResult = {
    filePath: '/fixture/new.txt',
    type: 'create',
    structuredPatch: [],
    content: 'line',
  }
  const prompt = '𠮷'.repeat(31)
  await inspect([user(prompt), edit], turns => {
    expect(turns[0]!.userPromptPreview).toBe('𠮷'.repeat(29) + '…')
  })
})

test('empty messages and mixed tool-result rows do not start a new turn', async () => {
  const edit = user([
    { type: 'text', text: 'tool output' },
    { type: 'tool_result', tool_use_id: 'ok', content: 'ok' },
  ])
  edit.toolUseResult = {
    filePath: '/fixture/new.txt',
    type: 'create',
    structuredPatch: [],
    content: 'line',
  }
  const mixed = user([
    { type: 'text', text: 'not a new prompt' },
    { type: 'tool_result', tool_use_id: 'other', content: 'ok' },
  ])
  await inspect([user('original prompt'), user(''), mixed, edit], turns => {
    expect(turns).toHaveLength(1)
    expect(turns[0]!.turnIndex).toBe(1)
    expect(turns[0]!.userPromptPreview).toBe('original prompt')
  })
})

test('a trailing newline is not an extra added line in a created file', async () => {
  const edit = user([
    { type: 'tool_result', tool_use_id: 'ok', content: 'ok' },
  ])
  edit.toolUseResult = {
    filePath: '/fixture/new.txt',
    type: 'create',
    structuredPatch: [],
    content: 'one\ntwo\n',
  }
  await inspect([user('create'), edit], turns => {
    const file = turns[0]!.files.get('/fixture/new.txt')!
    expect(file.linesAdded).toBe(2)
    expect(file.hunks[0]!.lines).toEqual(['+one', '+two'])
  })
})
