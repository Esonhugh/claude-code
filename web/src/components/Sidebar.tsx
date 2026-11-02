import { type ReactNode, type RefObject, useEffect, useState } from 'react'
import { ext } from '../extApi'
import { tilde } from '../files'
import type { SessionEnv } from '../protocol'
import { groupHistory, type HistoryEntry } from '../store'
import { Clawd, readStored, type T, writeStored } from './ui'

const COLLAPSED_KEY = 'claude-web-collapsed'

export type DialogKind =
  | 'mcp'
  | 'channels'
  | 'skills'
  | 'plugins'
  | 'memory'
  | 'hooks'
  | 'mods'
  | 'settings'
  | 'stats'
  | 'keys'

type ExtCounts = { channels?: string; memory?: string; mods?: string }

/** Counts for the Channels, Memory and Mods entries, reloaded whenever no dialog is open. */
function useExtCounts(env: SessionEnv, dialogOpen: boolean): ExtCounts {
  const [counts, setCounts] = useState<ExtCounts>({})
  const key = (env.mcpServers ?? [])
    .filter(m => m.status === 'connected')
    .map(m => m.name)
    .join('\n')
  useEffect(() => {
    if (dialogOpen) return
    const connected = key.split('\n')
    let live = true
    const set = (patch: ExtCounts) => live && setCounts(c => ({ ...c, ...patch }))
    ext.channels().then(
      list => set({ channels: String(list.filter(c => c.def && connected.includes(c.server)).length) }),
      () => undefined,
    )
    ext.memory().then(m => set({ memory: String(m.files.length) }), () => undefined)
    ext.mods().then(list => set({ mods: `${list.filter(m => m.on).length}/${list.length}` }), () => undefined)
    return () => {
      live = false
    }
  }, [dialogOpen, key])
  return counts
}

/** Left column: brand, new session, search, extension entries, history by folder, footer. */
export function Sidebar({
  t,
  open,
  uiName,
  env,
  history,
  historyDone,
  running,
  view,
  tempRoot,
  searchRef,
  onNew,
  onOpen,
  onRename,
  onStop,
  onMore,
  onDialog,
  dialogOpen = false,
  account,
}: {
  t: T
  open: boolean
  uiName: string
  env: SessionEnv
  history: HistoryEntry[]
  historyDone: boolean
  running: Record<string, boolean>
  view: string | null
  tempRoot?: string
  searchRef: RefObject<HTMLInputElement | null>
  onNew: (cwd?: string) => void
  onOpen: (entry: HistoryEntry) => void
  onRename: (entry: HistoryEntry, title: string) => void
  onStop: (id: string) => void
  onMore: () => void
  onDialog: (kind: DialogKind) => void
  dialogOpen?: boolean
  /** The account card (Account.tsx). */
  account: ReactNode
}) {
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    readStored(COLLAPSED_KEY, {}),
  )
  const [editing, setEditing] = useState<string | null>(null)
  const groups = groupHistory(history, filter, tempRoot)
  const activeCwd = history.find(h => h.id === view)?.cwd
  const toggle = (cwd: string) => {
    const next = { ...collapsed, [cwd]: !collapsed[cwd] }
    setCollapsed(next)
    writeStored(COLLAPSED_KEY, next)
  }
  const mcp = env.mcpServers
  const counts = useExtCounts(env, dialogOpen)
  const snav: { kind: DialogKind; ico: string; label: string; cnt?: string }[] = [
    {
      kind: 'mcp',
      ico: '⌁',
      label: 'MCP',
      cnt: mcp && `${mcp.filter(m => m.status === 'connected').length}/${mcp.length}`,
    },
    { kind: 'channels', ico: '⇆', label: 'Channels', cnt: counts.channels },
    { kind: 'skills', ico: '/', label: 'Skills', cnt: env.skills && String(env.skills.length) },
    { kind: 'plugins', ico: '⧉', label: t('plugins'), cnt: env.plugins && String(env.plugins.length) },
    { kind: 'memory', ico: 'M', label: t('memory'), cnt: counts.memory },
    { kind: 'hooks', ico: '↯', label: 'Hooks', cnt: env.hooks && String(env.hooks.length) },
    { kind: 'mods', ico: '◇', label: 'Mods', cnt: counts.mods },
  ]
  return (
    <aside className={`sessions sidebar${open ? ' open' : ''}`} id="sessions" aria-label={t('sessionGroup')}>
      <div className="head">
        <Clawd />
        <div className="wordmark">
          <b>{uiName}</b>
          <small>{env.version ? `v${env.version} · claude web` : 'claude web'}</small>
        </div>
      </div>
      <div className="tools">
        <div className="newwrap">
          <button className="newbtn new-chat" type="button" onClick={() => onNew()}>
            {t('newSession')}
          </button>
        </div>
        <input
          ref={searchRef}
          className="search"
          placeholder={t('searchSessionsPh')}
          aria-label={t('searchSessions')}
          autoComplete="off"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </div>
      <nav className="snav" aria-label={t('extensions')}>
        {snav.map(item => (
          <button type="button" key={item.kind} onClick={() => onDialog(item.kind)}>
            <span className="ico">{item.ico}</span>
            {item.label}
            {item.cnt && <span className="cnt">{item.cnt}</span>}
          </button>
        ))}
      </nav>
      <div className="history" role="navigation" aria-label={t('sessionGroup')}>
        {groups.map(group => {
          const opened = !!filter || group.cwd === activeCwd || !collapsed[group.cwd]
          const name = group.temp ? t('temporaryChats') : group.name || group.cwd
          return (
            <div className={`proj${group.temp ? ' temp' : ''}`} key={group.cwd}>
              <div className="proj-h">
                <button
                  type="button"
                  className="proj-t"
                  aria-expanded={opened}
                  title={group.cwd}
                  onClick={() => toggle(group.cwd)}
                >
                  <span className="caret" aria-hidden="true">
                    {opened ? '▾' : '▸'}
                  </span>
                  <b>{name}</b>
                  <small className={group.temp ? undefined : 'mono'}>{group.temp ? t('noFolderHint') : tilde(group.cwd)}</small>
                  <span className="cnt">{group.entries.length}</span>
                </button>
                {!group.temp && (
                  <button
                    type="button"
                    className="proj-new"
                    aria-label={t('newInFolder', { name })}
                    title={t('newInThisFolder')}
                    onClick={() => onNew(group.cwd || undefined)}
                  >
                    +
                  </button>
                )}
              </div>
              {opened &&
                group.entries.map(entry =>
                  editing === entry.id ? (
                    <div className="sess" key={entry.id}>
                      <input
                        className="rename"
                        defaultValue={entry.title}
                        autoFocus
                        aria-label={t('renameLabel')}
                        onBlur={() => setEditing(null)}
                        onKeyDown={e => {
                          if (e.key === 'Escape') setEditing(null)
                          if (e.key === 'Enter') {
                            const title = e.currentTarget.value.trim()
                            if (title) onRename(entry, title)
                            setEditing(null)
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <div
                      key={entry.id}
                      className="sess session-row"
                      role="button"
                      tabIndex={0}
                      title={entry.title}
                      aria-current={entry.id === view}
                      onClick={() => onOpen(entry)}
                      onDoubleClick={() => setEditing(entry.id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(entry)
                      }}
                    >
                      <span className="t session-title">
                        {running[entry.id] && <span className="live" aria-label={t('statusRunning')} />}
                        {entry.title}
                      </span>
                      <small>
                        {new Intl.DateTimeFormat(undefined, {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        }).format(entry.lastModified)}
                      </small>
                      <span className="acts">
                        <button
                          type="button"
                          className="act"
                          aria-label={t('renameLabel')}
                          title={t('renameLabel')}
                          onClick={e => {
                            e.stopPropagation()
                            setEditing(entry.id)
                          }}
                        >
                          ✎
                        </button>
                        {running[entry.id] && (
                          <button
                            type="button"
                            className="act"
                            aria-label={t('stopSession')}
                            title={t('stopSession')}
                            onClick={e => {
                              e.stopPropagation()
                              onStop(entry.id)
                            }}
                          >
                            ■
                          </button>
                        )}
                      </span>
                    </div>
                  ),
                )}
            </div>
          )
        })}
        {!groups.length && filter && <p className="note">{t('noMatchingSessions')}</p>}
        {!historyDone && !filter && (
          <button type="button" className="more" onClick={onMore}>
            {t('loadMore')}
          </button>
        )}
      </div>
      <div className="foot">
        {account}
      </div>
    </aside>
  )
}
