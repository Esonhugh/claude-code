import { describe, expect, it } from 'bun:test'
import { appReducer, groupHistory, initialAppState } from './store'

const replay = (uuid: string, text: string) => ({
  type: 'user',
  uuid,
  isReplay: true,
  message: { role: 'user', content: text },
})

describe('groupHistory', () => {
  it('groups by folder, newest group first, and filters by title or path', () => {
    const entries = [
      { id: 'a', title: 'Alpha', cwd: '/w/one', lastModified: 1 },
      { id: 'b', title: 'Beta', cwd: '/w/two', lastModified: 5 },
      { id: 'c', title: 'Gamma', cwd: '/w/one', lastModified: 3 },
    ]
    const groups = groupHistory(entries)
    expect(groups.map(g => g.name)).toEqual(['two', 'one'])
    expect(groups[1]!.entries.map(e => e.id)).toEqual(['c', 'a'])
    expect(groupHistory(entries, 'gam').map(g => g.entries.map(e => e.id))).toEqual([['c']])
    expect(groupHistory(entries, '/w/two')[0]!.entries[0]!.id).toBe('b')
  })
})

describe('appReducer', () => {
  it('loads a transcript read-only and prepends earlier pages without duplicates', () => {
    let state = appReducer(initialAppState, { type: 'view', id: 's1' })
    state = appReducer(state, { type: 'mode', id: 's1', mode: 'readonly' })
    state = appReducer(state, {
      type: 'loaded',
      id: 's1',
      messages: [replay('u2', 'second')],
      start: 1,
      workDir: '/w',
    })
    state = appReducer(state, {
      type: 'loaded',
      id: 's1',
      messages: [replay('u1', 'first'), replay('u2', 'second')],
      start: 0,
      prepend: true,
    })
    const chat = state.chats.s1!
    expect(chat.mode).toBe('readonly')
    expect(chat.start).toBe(0)
    expect(chat.workDir).toBe('/w')
    expect(chat.items.map(i => i.id)).toEqual(['u1', 'u2'])
  })

  it('adds a created session to the top of history and marks it running', () => {
    const state = appReducer(
      {
        ...initialAppState,
        history: [{ id: 'old', title: 'Old', cwd: '/w', lastModified: 1 }],
      },
      { type: 'created', id: 'new', workDir: '/w', title: 'Hello', start: { mode: 'acceptEdits' } },
    )
    expect(state.view).toBe('new')
    expect(state.history.map(h => h.id)).toEqual(['new', 'old'])
    expect(state.running.new).toBe(true)
    expect(state.chats.new!.permissionMode).toBe('acceptEdits')
  })

  it('keeps tab-created sessions the disk listing does not have yet', () => {
    let state = appReducer(initialAppState, {
      type: 'created', id: 'fresh', workDir: '/w', title: 'Fresh', start: { mode: 'default' },
    })
    state = appReducer(state, {
      type: 'history',
      entries: [{ id: 'disk', title: 'Disk', lastModified: 2 }],
      append: false,
      done: true,
    })
    expect(state.history.map(h => h.id)).toEqual(['fresh', 'disk'])
    state = appReducer(state, { type: 'renamed', id: 'disk', title: 'Renamed' })
    expect(state.history[1]!.title).toBe('Renamed')
  })
})
