import type { HistoryItem } from './api'
import {
  addError,
  addUserMessage,
  answerApproval,
  type Approval,
  type ApprovalChoice,
  type ChatState,
  initialState,
  queueUserMessage,
  reduce,
  rewindTo,
  setLocal,
  startRecap,
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

export type HistoryEntry = HistoryItem

export type StartOptions = { cwd?: string; mode: string; model?: string; temporary?: boolean; effort?: string }

export type AppState = {
  /** Session shown in the main area; null is the new-chat start page. */
  view: string | null
  chats: Record<string, SessionChat>
  history: HistoryEntry[]
  /** More sessions exist on disk than `history` holds. */
  historyMore: boolean
  /** Folder → last change, from the server (newest transcript or written file). */
  folders: Record<string, number>
  running: Record<string, boolean>
  start: StartOptions
}

export type ChatAction =
  | { type: 'message'; raw: unknown }
  | { type: 'messages'; raws: unknown[] }
  | { type: 'user'; text: string; images?: string[]; uuid?: string }
  | { type: 'queue'; text: string; images?: string[]; uuid: string }
  /** Stop: queued messages go back to the input instead of running next. */
  | { type: 'unqueue' }
  /** Send now: a queued message goes again under a new uuid. */
  | { type: 'requeue'; from: string; to: string }
  | { type: 'error'; text: string }
  | { type: 'answered'; approval: Approval; choice: ApprovalChoice }
  | { type: 'recap'; away?: number }
  | { type: 'rewound'; userId: string; note: string }
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
      rewindPoints?: string[]
    }
  | { type: 'mode'; id: string; mode: ChatMode }
  | { type: 'created'; id: string; workDir: string; title: string; start: StartOptions }
  | {
      type: 'history'
      entries: HistoryEntry[]
      folders: Record<string, number>
      more: boolean
    }
  | { type: 'running'; ids: string[] }
  | { type: 'meta'; id: string; patch: Partial<HistoryEntry> }
  | { type: 'removed'; id: string }
  | { type: 'startOptions'; patch: Partial<StartOptions> }

export const initialAppState: AppState = {
  view: null,
  chats: {},
  history: [],
  historyMore: false,
  folders: {},
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
    case 'messages':
      return action.raws.reduce(reduce, state)
    case 'user':
      return addUserMessage(state, action.text, action.images, action.uuid)
    case 'queue':
      return queueUserMessage(state, action.text, action.uuid, action.images)
    case 'unqueue':
      return { ...state, queued: [] }
    case 'requeue':
      return { ...state, queued: state.queued.map(q => (q.id === action.from ? { ...q, id: action.to } : q)) }
    case 'error':
      return addError(state, action.text)
    case 'answered':
      return answerApproval(state, action.approval, action.choice)
    case 'recap':
      return startRecap(state, action.away)
    case 'rewound':
      return rewindTo(state, action.userId, action.note)
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
            goal: chat.goal ?? folded.goal,
            startedAt: action.prepend ? (folded.startedAt ?? chat.startedAt) : (chat.startedAt ?? folded.startedAt),
            start: action.start,
            workDir: action.workDir ?? chat.workDir,
            // A live session's own answer wins over what the transcript says a resume would list.
            rewindPoints: chat.mode === 'live' ? chat.rewindPoints : (action.rewindPoints ?? chat.rewindPoints),
            // Task endings the coordinator read, where it read them; an older page keeps the ones shown.
            ...(!action.prepend && { taskNotes: folded.taskNotes, noteKeys: folded.noteKeys }),
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
    case 'history':
      return {
        ...state,
        history: [
          // Keep sessions created in this tab that the disk listing lacks yet.
          ...state.history.filter(h => state.chats[h.id] && !action.entries.some(e => e.id === h.id)),
          ...action.entries,
        ],
        folders: action.folders,
        historyMore: action.more,
      }
    case 'running':
      return {
        ...state,
        running: Object.fromEntries(action.ids.map(id => [id, true])),
      }
    case 'meta':
      return {
        ...state,
        history: state.history.map(h => (h.id === action.id ? { ...h, ...action.patch } : h)),
      }
    case 'removed':
      return { ...state, history: state.history.filter(h => h.id !== action.id) }
    case 'startOptions':
      return { ...state, start: { ...state.start, ...action.patch } }
  }
}

export type FolderGroup = { cwd: string; name: string; lastChange: number; count: number; entries: HistoryEntry[] }

export type SidebarGroups = { pinned: HistoryEntry[]; temporary: HistoryEntry[]; folders: FolderGroup[] }

const newestFirst = (a: HistoryEntry, b: HistoryEntry) => b.lastModified - a.lastModified

/**
 * The sidebar's sections: pinned sessions, temporary chats (folders under
 * `tempRoot`) and the rest by folder, folders ordered by their last change.
 * Archived sessions show only while searching; sessions moved into a
 * project show under the project.
 */
export function groupSidebar(
  entries: HistoryEntry[],
  { filter = '', tempRoot, folders = {} }: { filter?: string; tempRoot?: string; folders?: Record<string, number> } = {},
): SidebarGroups {
  const needle = filter.trim().toLowerCase()
  const isTemp = (cwd: string) =>
    !!tempRoot && (cwd === tempRoot || cwd.startsWith(`${tempRoot}/`) || cwd.startsWith(`${tempRoot}\\`))
  // Archived sessions and sessions moved into a project show only in a search.
  const listed = entries.filter(e => needle || (!e.projectId && !e.archived)).sort(newestFirst)
  const match = (e: HistoryEntry) => !needle || `${e.title}${e.cwd ?? ''}`.toLowerCase().includes(needle)
  const groups = new Map<string, HistoryEntry[]>()
  const temporary: HistoryEntry[] = []
  for (const entry of listed) {
    const cwd = entry.cwd ?? ''
    if (isTemp(cwd)) {
      if (!entry.pinnedAt && match(entry)) temporary.push(entry)
    } else {
      groups.set(cwd, [...(groups.get(cwd) ?? []), entry])
    }
  }
  const sorted = [...groups.entries()]
    .map(([cwd, list]) => ({
      cwd,
      name: cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd,
      lastChange: Math.max(folders[cwd] ?? 0, ...list.map(e => e.lastModified)),
      count: list.filter(e => !e.archived && !e.projectId).length,
      entries: list.filter(e => !e.pinnedAt && match(e)),
    }))
    .sort((a, b) => b.lastChange - a.lastChange)
  // Pinned sessions keep the order they have below: temporary chats, then folder by folder.
  const pinned = [...listed.filter(e => isTemp(e.cwd ?? '')), ...sorted.flatMap(g => groups.get(g.cwd)!)]
  return {
    pinned: pinned.filter(e => e.pinnedAt && match(e)),
    temporary,
    folders: sorted.filter(g => !needle || g.entries.length),
  }
}
