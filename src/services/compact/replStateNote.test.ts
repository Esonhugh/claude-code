import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as gate from '../../tools/REPLTool/codeModeGate.js'
import * as sessions from '../../tools/REPLTool/sessions.js'
import type { NormalizedUserMessage } from '../../types/message.js'
import { renderableSearchText } from '../../utils/transcriptSearch.js'
import { createUserMessage } from '../../utils/messages.js'
import { getCompactUserSummaryMessage } from './prompt.js'
import { isReplStateNote, replStateNote, replStateNoteForCompaction, withoutReplStateNote } from './replStateNote.js'

const LEAD = 'Your REPL VM state was kept across this compaction'

describe('replStateNote (official 2.1.325)', () => {
  test('wording for none, some and only unlisted bindings', () => {
    expect(replStateNote([])).toBe(`${LEAD}; no bindings are defined in it.`)
    expect(replStateNote(['a', 'b'])).toBe(`${LEAD}. These bindings are still defined: \`a\`, \`b\`.`)
    expect(replStateNote(['not an identifier'])).toBe(`${LEAD}. 1 binding is still defined in it, with names this note does not list.`)
    expect(replStateNote(['x'.repeat(81), '1a'])).toBe(`${LEAD}. 2 bindings are still defined in it, with names this note does not list.`)
  })

  test('lists at most 40 names and counts the rest', () => {
    const names = Array.from({ length: 43 }, (_, i) => `v${i}`)
    const note = replStateNote(names)
    expect(note.endsWith(', and 3 more this note does not list.')).toBe(true)
    expect(note).toContain('`v39`')
    expect(note).not.toContain('`v40`')
  })

  test('isReplStateNote accepts only what replStateNote makes', () => {
    for (const names of [[], ['a'], ['a', 'b c'], Array.from({ length: 45 }, (_, i) => `n${i}`)]) {
      expect(isReplStateNote(replStateNote(names))).toBe(true)
    }
    expect(isReplStateNote(`${LEAD}. These bindings are still defined: \`a b\`.`)).toBe(false)
    expect(isReplStateNote(`${LEAD}. 1 bindings are still defined in it, with names this note does not list.`)).toBe(false)
    expect(isReplStateNote('anything else')).toBe(false)
  })
})

describe('the note in a compact summary', () => {
  const note = replStateNote(['data', 'fetchAll'])

  test('goes before the resume instruction, and the UI text drops it', () => {
    const content = getCompactUserSummaryMessage('<summary>s</summary>', true, undefined, undefined, note)
    expect(content).toContain(`\n\n${note}\nContinue the conversation`)
    const shown = withoutReplStateNote(content, note)
    expect(shown).not.toContain(LEAD)
    expect(shown).toBe(getCompactUserSummaryMessage('<summary>s</summary>', true))
  })

  test('is not searchable in the transcript', () => {
    const content = getCompactUserSummaryMessage('<summary>s</summary>', false, undefined, undefined, note)
    const message = createUserMessage({
      content: [{ type: 'text', text: content }],
      isCompactSummary: true,
      modelOnlyText: note,
    }) as NormalizedUserMessage
    expect(renderableSearchText(message)).not.toContain('fetchall')
    expect(renderableSearchText(message)).toContain('summary')
  })

  test('text that is not a note is left alone', () => {
    expect(withoutReplStateNote('a\n\nb', 'b')).toBe('a\n\nb')
    expect(withoutReplStateNote('a', undefined)).toBe('a')
  })
})

describe('replStateNoteForCompaction', () => {
  const spies: Array<{ mockRestore(): void }> = []
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
  })

  function codeModeOn(on: boolean) {
    const spy = spyOn(gate, 'isCodeModeEnabled').mockReturnValue(on)
    spies.push(spy)
    return spy
  }

  function sessionsReturn(session: sessions.ReplSession | undefined) {
    const find = spyOn(sessions, 'findReplSession').mockReturnValue(session)
    spies.push(find)
    return find
  }

  function fakeSession(names: string[] | undefined): sessions.ReplSession {
    return { executor: { scriptGlobalNames: async () => names } } as unknown as sessions.ReplSession
  }

  test('asks the live context of this agent, or main', async () => {
    codeModeOn(true)
    const find = sessionsReturn(fakeSession(['x']))
    expect(await replStateNoteForCompaction(undefined)).toBe(replStateNote(['x']))
    expect(await replStateNoteForCompaction('agent-1')).toBe(replStateNote(['x']))
    expect(find.mock.calls).toEqual([['main'], ['agent-1']])
  })

  test('no note without a live context or with Code Mode off', async () => {
    const codeMode = codeModeOn(true)
    const find = sessionsReturn(undefined)
    expect(await replStateNoteForCompaction(undefined)).toBeUndefined()
    find.mockReturnValue(fakeSession(undefined))
    expect(await replStateNoteForCompaction(undefined)).toBeUndefined()
    codeMode.mockReturnValue(false)
    find.mockReturnValue(fakeSession(['x']))
    expect(await replStateNoteForCompaction(undefined)).toBeUndefined()
  })
})
