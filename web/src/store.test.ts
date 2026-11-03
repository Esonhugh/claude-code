import { describe, expect, it } from 'bun:test'
import { appReducer, groupSidebar, initialAppState } from './store'

const replay = (uuid: string, text: string) => ({
  type: 'user',
  uuid,
  isReplay: true,
  message: { role: 'user', content: text },
})

describe('groupSidebar', () => {
  it('groups by folder, folders by last change, and filters by title or path', () => {
    const entries = [
      { id: 'a', title: 'Alpha', cwd: '/w/one', lastModified: 1 },
      { id: 'b', title: 'Beta', cwd: '/w/two', lastModified: 5 },
      { id: 'c', title: 'Gamma', cwd: '/w/one', lastModified: 3 },
    ]
    const { folders } = groupSidebar(entries)
    expect(folders.map(g => [g.name, g.lastChange, g.count])).toEqual([['two', 5, 1], ['one', 3, 2]])
    expect(folders[1]!.entries.map(e => e.id)).toEqual(['c', 'a'])
    // A file written in /w/one after the last session moves the folder up.
    expect(groupSidebar(entries, { folders: { '/w/one': 9 } }).folders.map(g => g.name)).toEqual(['one', 'two'])
    expect(groupSidebar(entries, { filter: 'gam' }).folders.map(g => g.entries.map(e => e.id))).toEqual([['c']])
    expect(groupSidebar(entries, { filter: '/w/two' }).folders[0]!.entries[0]!.id).toBe('b')
  })

  it('puts pinned sessions and temporary chats in their own sections', () => {
    const entries = [
      { id: 'a', title: 'Alpha', cwd: '/c/web/temp/chat-1', lastModified: 1 },
      { id: 'b', title: 'Beta', cwd: '/w/two', lastModified: 5, pinnedAt: 1 },
      { id: 'c', title: 'Gamma', cwd: '/c/web/temp/chat-2', lastModified: 3 },
      { id: 'd', title: 'Delta', cwd: '/w/two', lastModified: 4 },
    ]
    const groups = groupSidebar(entries, { tempRoot: '/c/web/temp' })
    expect(groups.pinned.map(e => e.id)).toEqual(['b'])
    expect(groups.temporary.map(e => e.id)).toEqual(['c', 'a'])
    expect(groups.folders.map(g => [g.cwd, g.count, g.entries.map(e => e.id)])).toEqual([['/w/two', 2, ['d']]])
  })

  it('orders pinned sessions as their folders are ordered', () => {
    const entries = [
      { id: 'a', title: 'A', cwd: '/w/old', lastModified: 9, pinnedAt: 1 },
      { id: 'b', title: 'B', cwd: '/w/new', lastModified: 2, pinnedAt: 1 },
      { id: 'c', title: 'C', cwd: '/w/new', lastModified: 10 },
    ]
    const groups = groupSidebar(entries, { folders: { '/w/old': 9, '/w/new': 20 } })
    expect(groups.pinned.map(e => e.id)).toEqual(['b', 'a'])
  })

  it('hides archived sessions and sessions moved into a project unless searching', () => {
    const entries = [
      { id: 'a', title: 'Alpha', cwd: '/w', lastModified: 1, archived: true },
      { id: 'b', title: 'Beta', cwd: '/w', lastModified: 2, projectId: 'p1' },
      { id: 'c', title: 'Gamma', cwd: '/w', lastModified: 3 },
    ]
    expect(groupSidebar(entries).folders[0]!.entries.map(e => e.id)).toEqual(['c'])
    expect(groupSidebar(entries, { filter: 'alp' }).folders[0]!.entries.map(e => e.id)).toEqual(['a'])
    // A moved session belongs to its project; search still finds it.
    expect(groupSidebar(entries, { filter: 'bet' }).folders[0]!.entries.map(e => e.id)).toEqual(['b'])
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
      folders: {},
      more: false,
    })
    expect(state.history.map(h => h.id)).toEqual(['fresh', 'disk'])
    state = appReducer(state, { type: 'meta', id: 'disk', patch: { title: 'Renamed', pinnedAt: 1 } })
    expect(state.history[1]).toMatchObject({ title: 'Renamed', pinnedAt: 1 })
    state = appReducer(state, { type: 'removed', id: 'fresh' })
    expect(state.history.map(h => h.id)).toEqual(['disk'])
  })
})

describe('queued messages on stop', () => {
  it('drops them so the interrupted turn does not carry them into the next one', () => {
    let state = appReducer(initialAppState, { type: 'created', id: 's', workDir: '/w', title: 't', start: { mode: 'default' } })
    const chat = (action: Parameters<typeof appReducer>[1] & { type: 'chat' }) => (state = appReducer(state, action))
    chat({ type: 'chat', id: 's', action: { type: 'user', text: 'first', uuid: 'u1' } })
    chat({ type: 'chat', id: 's', action: { type: 'queue', text: 'second', uuid: 'u2' } })
    chat({ type: 'chat', id: 's', action: { type: 'unqueue' } })
    chat({ type: 'chat', id: 's', action: { type: 'message', raw: { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [] } } })
    expect(state.chats.s!.queued).toEqual([])
    expect(state.chats.s!.busy).toBe(false)
    expect(state.chats.s!.items.filter(i => i.kind === 'user').map(i => i.id)).toEqual(['u1'])
  })
})
