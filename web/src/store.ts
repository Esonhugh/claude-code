import {
  addError,
  addUserMessage,
  type ChatState,
  initialState,
  reduce,
  removeApproval,
  setLocal,
} from './protocol'

/**
 * live: this tab holds the session's socket. readonly: a transcript from disk
 * (no process until the user starts typing). elsewhere: another tab owns it.
 */
export type ChatMode = 'live' | 'readonly' | 'elsewhere' | 'connecting'

export type SessionChat = ChatState & {
  mode: ChatMode
  /** Index of the first loaded transcript message; > 0 means more above. */
  start: number
  workDir?: string
}

export type HistoryEntry = {
  id: string
  title: string
  cwd?: string
  lastModified: number
}

export type StartOptions = { cwd?: string; mode: string; model?: string }

export type AppState = {
  /** Session shown in the main area; null is the new-chat start page. */
  view: string | null
  chats: Record<string, SessionChat>
  history: HistoryEntry[]
  historyDone: boolean
  running: Record<string, boolean>
  start: StartOptions
}

export type ChatAction =
  | { type: 'message'; raw: unknown }
  | { type: 'user'; text: string }
  | { type: 'error'; text: string }
  | { type: 'answered'; requestId: string }
  | { type: 'local'; patch: Parameters<typeof setLocal>[1] }

export type AppAction =
  | { type: 'chat'; id: string; action: ChatAction }
  | { type: 'view'; id: string | null }
  | {
      type: 'loaded'
      id: string
      messages: unknown[]
      start: number
      workDir?: string
      prepend?: boolean
    }
  | { type: 'mode'; id: string; mode: ChatMode }
  | { type: 'created'; id: string; workDir: string; title: string; start: StartOptions }
  | { type: 'history'; entries: HistoryEntry[]; append: boolean; done: boolean }
  | { type: 'running'; ids: string[] }
  | { type: 'renamed'; id: string; title: string }
  | { type: 'startOptions'; patch: Partial<StartOptions> }

export const initialAppState: AppState = {
  view: null,
  chats: {},
  history: [],
  historyDone: false,
  running: {},
  start: { mode: 'default' },
}

function emptyChat(mode: ChatMode): SessionChat {
  return { ...initialState, mode, start: 0 }
}

function reduceChat(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'message':
      return reduce(state, action.raw)
    case 'user':
      return addUserMessage(state, action.text)
    case 'error':
      return addError(state, action.text)
    case 'answered':
      return removeApproval(state, action.requestId)
    case 'local':
      return setLocal(state, action.patch)
  }
}

function fold(messages: unknown[]): ChatState {
  return messages.reduce<ChatState>(reduce, initialState)
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'chat': {
      const chat = state.chats[action.id]
      if (!chat) return state
      const next = reduceChat(chat, action.action)
      return { ...state, chats: { ...state.chats, [action.id]: { ...chat, ...next } } }
    }
    case 'view':
      return { ...state, view: action.id }
    case 'loaded': {
      const chat = state.chats[action.id] ?? emptyChat('readonly')
      const folded = fold(action.messages)
      const items = action.prepend
        ? [
            ...folded.items.filter(i => !chat.items.some(c => c.id === i.id)),
            ...chat.items,
          ]
        : folded.items
      return {
        ...state,
        chats: {
          ...state.chats,
          [action.id]: {
            ...chat,
            items,
            model: chat.model ?? folded.model,
            start: action.start,
            workDir: action.workDir ?? chat.workDir,
          },
        },
      }
    }
    case 'mode': {
      const chat = state.chats[action.id] ?? emptyChat(action.mode)
      return {
        ...state,
        chats: { ...state.chats, [action.id]: { ...chat, mode: action.mode } },
        running:
          action.mode === 'live'
            ? { ...state.running, [action.id]: true }
            : state.running,
      }
    }
    case 'created':
      return {
        ...state,
        view: action.id,
        chats: {
          ...state.chats,
          [action.id]: {
            ...emptyChat('connecting'),
            workDir: action.workDir,
            permissionMode: action.start.mode,
            model: action.start.model,
          },
        },
        running: { ...state.running, [action.id]: true },
        history: [
          {
            id: action.id,
            title: action.title,
            cwd: action.workDir,
            lastModified: Date.now(),
          },
          ...state.history.filter(h => h.id !== action.id),
        ],
      }
    case 'history': {
      const merged = action.append
        ? [
            ...state.history,
            ...action.entries.filter(e => !state.history.some(h => h.id === e.id)),
          ]
        : [
            // Keep sessions created in this tab that the disk listing lacks yet.
            ...state.history.filter(
              h => state.chats[h.id] && !action.entries.some(e => e.id === h.id),
            ),
            ...action.entries,
          ]
      return { ...state, history: merged, historyDone: action.done }
    }
    case 'running':
      return {
        ...state,
        running: Object.fromEntries(action.ids.map(id => [id, true])),
      }
    case 'renamed':
      return {
        ...state,
        history: state.history.map(h =>
          h.id === action.id ? { ...h, title: action.title } : h,
        ),
      }
    case 'startOptions':
      return { ...state, start: { ...state.start, ...action.patch } }
  }
}

export type HistoryGroup = { cwd: string; name: string; entries: HistoryEntry[] }

/** Groups sessions by working directory, groups ordered by their newest session. */
export function groupHistory(entries: HistoryEntry[], filter = ''): HistoryGroup[] {
  const needle = filter.trim().toLowerCase()
  const groups = new Map<string, HistoryEntry[]>()
  for (const entry of entries) {
    if (
      needle &&
      !entry.title.toLowerCase().includes(needle) &&
      !(entry.cwd ?? '').toLowerCase().includes(needle)
    ) {
      continue
    }
    const key = entry.cwd ?? ''
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  return [...groups.entries()]
    .map(([cwd, list]) => ({
      cwd,
      name: cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd,
      entries: list.sort((a, b) => b.lastModified - a.lastModified),
    }))
    .sort((a, b) => b.entries[0]!.lastModified - a.entries[0]!.lastModified)
}
