import { type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  deleteTranscript,
  patchSessionMeta,
  patchProject,
  type Project,
  removeProject,
  type SessionMetaPatch,
} from '../api'
import { tilde } from '../files'
import type { Lang } from '../i18n'
import type { SessionEnv } from '../protocol'
import { groupSidebar, type HistoryEntry } from '../store'
import { Clawd, readStored, type T, writeStored } from './ui'

const COLLAPSED_KEY = 'claude-web-collapsed'
// Folders after the first few start collapsed until the user opens them.
const OPEN_FOLDERS = 2

/** A project row, with the counts its coordinator's chat has when it is loaded. */
export type SidebarProject = Project & { tasks?: number; tasksRunning?: number; needsYou?: number }

export type DialogKind =
  | 'mcp'
  | 'skills'
  | 'plugins'
  | 'memory'
  | 'hooks'
  | 'settings'
  | 'stats'
  | 'keys'

/** A hover card: a title and the fields that are known; `mono` marks the id. */
type Tip = { t: string; rows: { k: string; v: string; mono?: boolean }[] }

const LOCALES: Record<Lang, string> = { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', en: 'en-US' }

/** "11:02" today ("Today 11:02" with `today`), "Yesterday", "Oct 30" this year, "Oct 30, 2025" before. */
function when(ts: number, lang: Lang, t: T, today = false): string {
  const date = new Date(ts)
  const now = new Date()
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(now) - day(date)) / 864e5)
  const time = date.toTimeString().slice(0, 5)
  if (days === 0) return today ? t('todayAt', { time }) : time
  if (days === 1) return t('yesterday')
  return new Intl.DateTimeFormat(LOCALES[lang], {
    month: lang === 'en' ? 'short' : 'long',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
  }).format(date)
}

type Menu = { x: number; y: number; step: 'main' | 'move' | 'confirm' } & (
  | { kind: 'sess'; entry: HistoryEntry }
  | { kind: 'pj'; project: SidebarProject }
)

/**
 * Left column: brand, new session, search, extension entries, then pinned
 * sessions, projects, temporary chats and recent folders, and the footer.
 */
export function Sidebar({
  t,
  lang,
  open,
  uiName,
  env,
  history,
  historyMore,
  folders,
  running,
  view,
  tempRoot,
  searchRef,
  onNew,
  onOpen,
  onPatched,
  onDeleted,
  onMore,
  onDialog,
  account,
  projects,
  projectId,
  onProject,
  onNewProject,
  onProjectSettings,
  onProjectChanged,
}: {
  t: T
  lang: Lang
  open: boolean
  uiName: string
  env: SessionEnv
  history: HistoryEntry[]
  historyMore: boolean
  folders: Record<string, number>
  running: Record<string, boolean>
  view: string | null
  tempRoot?: string
  searchRef: RefObject<HTMLInputElement | null>
  onNew: (start?: { cwd?: string; temporary?: boolean }) => void
  onOpen: (entry: HistoryEntry) => void
  /** A session's marks changed on the server. */
  onPatched: (id: string, patch: Partial<HistoryEntry>) => void
  onDeleted: (id: string) => void
  onMore: () => void
  onDialog: (kind: DialogKind) => void
  /** The account card (Account.tsx). */
  account: ReactNode
  projects: SidebarProject[]
  /** The project shown, if any. */
  projectId?: string
  onProject: (project: Project) => void
  onNewProject: () => void
  onProjectSettings: (project: Project) => void
  /** A project was renamed (`project`), or archived or deleted (none). */
  onProjectChanged: (id: string, project?: Project) => void
}) {
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readStored(COLLAPSED_KEY, {}))
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [flashText, setFlashText] = useState<string>()
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const asideRef = useRef<HTMLElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const q = filter.trim().toLowerCase()
  const groups = groupSidebar(history, { filter, tempRoot, folders })
  const activeCwd = history.find(h => h.id === view)?.cwd

  useEffect(() => () => clearTimeout(flashTimer.current), [])
  // Opening a session expands its folder once; the folder can still be collapsed after.
  useEffect(() => {
    if (activeCwd !== undefined) setCollapsed(c => (c[activeCwd] === false ? c : { ...c, [activeCwd]: false }))
  }, [view, activeCwd])

  const flash = (text: string) => {
    setFlashText(text)
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlashText(undefined), 2200)
  }
  const fail = (err: unknown) => flash(err instanceof Error ? err.message : String(err))

  const isOpen = (key: string, byDefault: boolean) => !(collapsed[key] ?? !byDefault)
  const toggle = (key: string, byDefault: boolean) => {
    const next = { ...collapsed, [key]: isOpen(key, byDefault) }
    setCollapsed(next)
    writeStored(COLLAPSED_KEY, next)
  }

  const patch = (entry: HistoryEntry, body: SessionMetaPatch, local: Partial<HistoryEntry>) =>
    patchSessionMeta(entry.id, body).then(() => onPatched(entry.id, local))

  // ---- hover card ----
  const [tip, setTip] = useState<(Tip & { key: string; top: number }) | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const tipTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const tipKey = useRef<string | null>(null)
  const tipSkip = useRef<string | null>(null)
  const showTip = (el: HTMLElement) => {
    const key = el.dataset.tip!
    tipKey.current = key
    setTip({ key, ...(JSON.parse(key) as Tip), top: el.getBoundingClientRect().top })
  }
  const hideTip = (delay = 250) => {
    clearTimeout(tipTimer.current)
    tipTimer.current = setTimeout(() => {
      tipKey.current = null
      setTip(null)
    }, delay)
  }
  useEffect(() => {
    const aside = asideRef.current!
    const over = (e: MouseEvent) => {
      const el = (e.target as Element).closest<HTMLElement>('[data-tip]')
      if (!el) return hideTip()
      const key = el.dataset.tip!
      // After a click the row re-renders under the pointer; its card stays closed until another row.
      if (key === tipSkip.current) return
      tipSkip.current = null
      clearTimeout(tipTimer.current)
      if (tipKey.current === key) return
      // While a card is open, wait before switching so a diagonal move onto the card keeps it.
      if (tipKey.current) tipTimer.current = setTimeout(() => showTip(el), 180)
      else showTip(el)
    }
    // Moving onto the card (rendered outside the column) keeps it.
    const leave = (e: MouseEvent) => {
      if (!tipRef.current?.contains(e.relatedTarget as Node | null)) hideTip()
    }
    const down = (e: MouseEvent) => {
      tipSkip.current = (e.target as Element).closest<HTMLElement>('[data-tip]')?.dataset.tip ?? null
      hideTip(0)
    }
    const scroll = () => hideTip(0)
    const list = historyRef.current!
    aside.addEventListener('mouseover', over)
    aside.addEventListener('mouseleave', leave)
    aside.addEventListener('mousedown', down)
    list.addEventListener('scroll', scroll)
    return () => {
      clearTimeout(tipTimer.current)
      aside.removeEventListener('mouseover', over)
      aside.removeEventListener('mouseleave', leave)
      aside.removeEventListener('mousedown', down)
      list.removeEventListener('scroll', scroll)
    }
  }, [])
  useLayoutEffect(() => {
    const card = tipRef.current
    if (!tip || !card) return
    const side = asideRef.current!.getBoundingClientRect()
    // Measured where it would sit, so on a narrow screen it wraps instead of overflowing.
    card.style.left = `${side.right + 6}px`
    card.style.left = `${Math.min(side.right + 6, innerWidth - card.offsetWidth - 8)}px`
    card.style.top = `${Math.min(tip.top, innerHeight - card.offsetHeight - 8)}px`
  }, [tip])

  // ---- right-click menu ----
  const closeMenu = () => setMenu(null)
  const openMenu = (e: ReactMouseEvent, target: Pick<Menu, 'kind'> & Partial<Menu>) => {
    e.preventDefault()
    hideTip(0)
    setMenu({ ...target, x: e.clientX, y: e.clientY, step: 'main' } as Menu)
  }
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!menu || !el) return
    el.style.left = `${Math.min(menu.x, innerWidth - el.offsetWidth - 8)}px`
    el.style.top = `${Math.min(menu.y, innerHeight - el.offsetHeight - 8)}px`
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [menu])

  const sessionAction = (entry: HistoryEntry, action: string) => {
    closeMenu()
    if (action === 'unread') {
      patch(entry, { unread: !entry.unread }, { unread: !entry.unread }).catch(fail)
    } else if (action === 'pin') {
      const pinned = !entry.pinnedAt
      patch(entry, { pinned }, { pinnedAt: pinned ? Date.now() : undefined }).catch(fail)
    } else if (action === 'rename') {
      setRenaming(entry.id)
    } else if (action === 'archive') {
      patch(entry, { archived: true, pinned: false }, { archived: true, pinnedAt: undefined }).then(
        () => flash(t('flashArchived', { name: entry.title })),
        fail,
      )
    } else if (action === 'really-delete') {
      deleteTranscript(entry.id).then(() => {
        onDeleted(entry.id)
        flash(t('flashDeleted', { name: entry.title }))
      }, fail)
    }
  }
  const moveTo = (entry: HistoryEntry, project: Project) => {
    closeMenu()
    patch(entry, { project_id: project.id, pinned: false }, { projectId: project.id, pinnedAt: undefined }).then(
      () => flash(t('flashMoved', { name: project.name })),
      fail,
    )
  }
  const projectAction = (project: Project, action: string) => {
    closeMenu()
    if (action === 'rename') setRenaming(project.id)
    else if (action === 'settings') onProjectSettings(project)
    else if (action === 'archive' || action === 'really-delete') {
      const purge = action === 'really-delete'
      removeProject(project.id, purge).then(() => {
        onProjectChanged(project.id)
        flash(t(purge ? 'flashProjectDeleted' : 'flashProjectArchived', { name: project.name }))
      }, fail)
    }
  }
  const menuAction = (action: string) => {
    if (!menu) return
    if (action === 'back' || action === 'cancel') return setMenu({ ...menu, step: 'main' })
    if (action === 'move' || action === 'delete') return setMenu({ ...menu, step: action === 'move' ? 'move' : 'confirm' })
    if (menu.kind === 'pj') projectAction(menu.project, action)
    else sessionAction(menu.entry, action)
  }
  useEffect(() => {
    if (!menu) return
    const click = (e: MouseEvent) => {
      if (!e.composedPath().includes(menuRef.current!)) setMenu(null)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        return setMenu(null)
      }
      if (menu.step !== 'main' || e.metaKey || e.ctrlKey || e.altKey) return
      const keys: Record<string, string> =
        menu.kind === 'pj'
          ? { r: 'rename', s: 'settings', a: 'archive', d: 'delete' }
          : { u: 'unread', p: 'pin', r: 'rename', a: 'archive', d: 'delete' }
      const action = keys[e.key.toLowerCase()]
      if (!action) return
      e.preventDefault()
      menuAction(action)
    }
    document.addEventListener('click', click)
    addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('click', click)
      removeEventListener('keydown', key, true)
    }
  })

  // ---- rows ----
  const tipAttr = (o: Tip) => ({ 'data-tip': JSON.stringify(o) })
  const renameInput = (value: string, commit: (title: string) => void) => {
    let done = false
    const finish = (input: HTMLInputElement, ok: boolean) => {
      if (done) return
      done = true
      const next = input.value.trim()
      setRenaming(null)
      if (ok && next && next !== value) commit(next)
    }
    return (
      <input
        className="ren"
        defaultValue={value}
        aria-label={t('newName')}
        autoFocus
        onFocus={e => e.currentTarget.select()}
        onClick={e => e.stopPropagation()}
        onBlur={e => finish(e.currentTarget, true)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            finish(e.currentTarget, true)
          }
          if (e.key === 'Escape') {
            e.stopPropagation()
            finish(e.currentTarget, false)
          }
        }}
      />
    )
  }

  const sessRow = (entry: HistoryEntry, temp: boolean, pinned = false) => {
    const live = running[entry.id]
    const tipRows: Tip['rows'] = [
      { k: t('tipLastModified'), v: live ? t('justNow') : when(entry.lastModified, lang, t) },
      { k: temp ? '' : t('tipFolder'), v: temp || !entry.cwd ? '' : tilde(entry.cwd) },
      { k: t('tipStatus'), v: live ? t('statusRunning') : entry.unread ? t('tipUnread') : '' },
      { k: t('tipChanges'), v: entry.files ? t('tipFiles', { n: String(entry.files) }) : '' },
      { k: 'ID', v: entry.id, mono: true },
    ]
    const label = entry.label === 'id' ? ' mono sid' : entry.label === 'message' ? ' untitled' : ''
    const dot = live ? <span className="live" /> : entry.unread ? <span className="ud" /> : null
    const pinLabel = pinned ? t('unpinSession') : t('pinSession')
    return (
      <div className="srow" key={entry.id}>
        {renaming === entry.id ? (
          <div className={`sess session-row${entry.unread ? ' unread' : ''}`} aria-current={entry.id === view}>
            <span className="t session-title">
              {renameInput(entry.title, title => patch(entry, { title }, { title, label: 'title' }).catch(fail))}
            </span>
          </div>
        ) : (
          <button
            className={`sess session-row${entry.unread ? ' unread' : ''}`}
            type="button"
            aria-current={entry.id === view}
            {...tipAttr({ t: entry.title, rows: tipRows.filter(r => r.k && r.v) })}
            onClick={() => {
              if (entry.unread) patch(entry, { unread: false }, { unread: false }).catch(fail)
              onOpen(entry)
            }}
            onContextMenu={e => openMenu(e, { kind: 'sess', entry })}
          >
            <span className={`t session-title${label}`}>
              <span className="lead" aria-hidden="true">{dot}</span>
              {entry.title}
            </span>
          </button>
        )}
        <button
          type="button"
          className="pin-b"
          aria-label={pinLabel}
          title={pinLabel}
          onClick={() => {
            const next = !entry.pinnedAt
            patch(entry, { pinned: next }, { pinnedAt: next ? Date.now() : undefined }).catch(fail)
          }}
        >
          {pinned ? '✕' : '⇡'}
        </button>
      </div>
    )
  }

  const projectRow = (p: SidebarProject) => {
    const needs = p.needsYou ?? 0
    const run = p.tasksRunning ?? 0
    const rows: Tip['rows'] = [
      { k: t('tipFolder'), v: tilde(p.cwd) },
      {
        k: t('tipTasks'),
        v:
          p.tasks === undefined
            ? ''
            : run
              ? t('tipTaskRunning', { n: String(p.tasks), r: String(run) })
              : t('tipTaskCount', { n: String(p.tasks) }),
      },
      { k: t('tipNeedsYou'), v: needs ? t('tipTaskCount', { n: String(needs) }) : '' },
      { k: t('tipStarted'), v: when(p.created_at, lang, t, true) },
    ]
    return (
      <div className="srow" key={p.id}>
        {renaming === p.id ? (
          <div className="sess pjrow">
            <span className="t">
              {renameInput(p.name, name =>
                patchProject(p.id, { name }).then(saved => onProjectChanged(p.id, saved), fail),
              )}
            </span>
          </div>
        ) : (
          <button
            className="sess pjrow"
            type="button"
            data-pj={p.id}
            aria-current={p.id === projectId}
            {...tipAttr({ t: p.name, rows: rows.filter(r => r.v) })}
            onClick={() => onProject(p)}
            onContextMenu={e => openMenu(e, { kind: 'pj', project: p })}
          >
            <span className="t">
              <span className="lead" aria-hidden="true">{run > 0 ? <span className="live" /> : <span className="pjico">⌗</span>}</span>
              {p.name}
            </span>
            {needs > 0 && (
              <span className="pjn" title={t('tipNeedsYou')}>
                {needs}
              </span>
            )}
          </button>
        )}
      </div>
    )
  }

  const section = (key: string, label: string, body: ReactNode, extra?: ReactNode) => {
    const opened = isOpen(`#${key}`, true)
    return (
      <div className="sb-sec">
        <div className="sb-h">
          <button type="button" aria-expanded={opened} onClick={() => toggle(`#${key}`, true)}>
            <span className="caret" aria-hidden="true">
              {opened ? '▾' : '▸'}
            </span>
            {label}
          </button>
          {extra}
        </div>
        {opened && body}
      </div>
    )
  }

  const pins = groups.pinned.map(e => sessRow(e, !!tempRoot && !!e.cwd?.startsWith(tempRoot), true))
  const projectRows = projects.filter(p => !q || `${p.name}${p.cwd}`.toLowerCase().includes(q)).map(projectRow)
  const tempRows = groups.temporary.map(e => sessRow(e, true))
  const dirs = groups.folders.map((g, i) => {
    const opened = !!q || isOpen(g.cwd, i < OPEN_FOLDERS)
    const name = g.name || g.cwd
    const tip: Tip = {
      t: name,
      rows: [
        { k: t('tipFolder'), v: tilde(g.cwd) },
        { k: t('tipLastModified'), v: when(g.lastChange, lang, t) },
        { k: t('tipSessions'), v: t('tipSessionCount', { n: String(g.count) }) },
      ],
    }
    return (
      <div className="proj" key={g.cwd}>
        <div className="proj-h">
          <button
            type="button"
            className="proj-t"
            aria-expanded={opened}
            {...tipAttr(tip)}
            onClick={() => toggle(g.cwd, i < OPEN_FOLDERS)}
          >
            <span className="caret" aria-hidden="true">
              {opened ? '▾' : '▸'}
            </span>
            <b>{name}</b>
            <span className="cnt">{g.count}</span>
          </button>
          <button
            type="button"
            className="proj-new"
            aria-label={t('newInFolder', { name })}
            title={t('newInThisFolder')}
            onClick={() => onNew({ cwd: g.cwd || undefined })}
          >
            +
          </button>
        </div>
        {opened && g.entries.map(e => sessRow(e, false))}
      </div>
    )
  })

  const snav: { kind: DialogKind; ico: string; label: string }[] = [
    { kind: 'mcp', ico: '⌁', label: 'MCP' },
    { kind: 'skills', ico: '/', label: 'Skills' },
    { kind: 'plugins', ico: '⧉', label: t('plugins') },
    { kind: 'memory', ico: 'M', label: t('memory') },
    { kind: 'hooks', ico: '↯', label: 'Hooks' },
  ]
  const empty = !pins.length && !tempRows.length && !dirs.length && !projectRows.length

  const menuItem = (action: string, ico: string, label: string, key: string, bad = false) => (
    <button type="button" className={`mi${bad ? ' bad' : ''}`} role="menuitem" onClick={() => menuAction(action)}>
      <span className="ico">{ico}</span>
      {label}
      <kbd>{key}</kbd>
    </button>
  )
  const menuBody = () => {
    if (!menu) return null
    const name = menu.kind === 'pj' ? menu.project.name : menu.entry.title
    if (menu.step === 'confirm') {
      return (
        <>
          <div className="ctxq">{t('deleteConfirm', { name })}</div>
          <div className="btns" style={{ padding: '4px 8px 6px' }}>
            <button type="button" className="btn" onClick={() => menuAction('cancel')}>
              {t('cancel')}
            </button>
            <button type="button" className="btn danger" onClick={() => menuAction('really-delete')}>
              {t('deleteLabel')}
            </button>
          </div>
        </>
      )
    }
    if (menu.kind === 'sess' && menu.step === 'move') {
      const entry = menu.entry
      return (
        <>
          <button type="button" className="mi" onClick={() => menuAction('back')}>
            <span className="ico">‹</span>
            {t('moveToProject')}
          </button>
          <hr />
          {projects.map(p => (
            <button type="button" className="mi" key={p.id} onClick={() => moveTo(entry, p)}>
              <span className="ico">⌗</span>
              <span>{p.name}</span>
            </button>
          ))}
        </>
      )
    }
    if (menu.kind === 'pj') {
      return (
        <>
          {menuItem('rename', '✎', t('renameLabel'), 'R')}
          {menuItem('settings', '⚙', t('projectSettings'), 'S')}
          <hr />
          {menuItem('archive', '▣', t('archive'), 'A')}
          {menuItem('delete', '⌫', t('deleteLabel'), 'D', true)}
        </>
      )
    }
    const entry = menu.entry
    return (
      <>
        {menuItem('unread', entry.unread ? '●' : '○', entry.unread ? t('markRead') : t('markUnread'), 'U')}
        {menuItem('pin', '⇡', entry.pinnedAt ? t('unpinSession') : t('pinSession'), 'P')}
        {menuItem('rename', '✎', t('renameLabel'), 'R')}
        <button
          type="button"
          className="mi"
          role="menuitem"
          disabled={!projects.length}
          onClick={() => menuAction('move')}
        >
          <span className="ico">⌗</span>
          {t('moveToProject')}
          <span className="chev">›</span>
        </button>
        <hr />
        {menuItem('archive', '▣', t('archive'), 'A')}
        {menuItem('delete', '⌫', t('deleteLabel'), 'D', true)}
      </>
    )
  }

  return (
    <aside ref={asideRef} className={`sessions sidebar${open ? ' open' : ''}`} id="sessions" aria-label={t('sessionGroup')}>
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
          </button>
        ))}
      </nav>
      <div className="history" ref={historyRef} role="navigation" aria-label={t('sessionGroup')}>
        {pins.length > 0 && section('pin', t('sbPinned'), pins)}
        {(projectRows.length > 0 || !q) &&
          section(
            'pj',
            t('projectsSection'),
            projectRows,
            <button type="button" className="proj-new" aria-label={t('newProject')} title={t('newProject')} onClick={onNewProject}>
              +
            </button>,
          )}
        {tempRows.length > 0 &&
          section(
            'temp',
            t('temporaryChats'),
            tempRows,
            <button
              type="button"
              className="proj-new"
              aria-label={t('newTempChat')}
              title={t('newTempChat')}
              onClick={() => onNew({ temporary: true })}
            >
              +
            </button>,
          )}
        {dirs.length > 0 && section('dirs', t('sbRecentFolders'), dirs)}
        {empty && q && <p className="note">{t('noMatchingSessions')}</p>}
        {historyMore && !q && (
          <button type="button" className="more" onClick={onMore}>
            {t('loadMore')}
          </button>
        )}
      </div>
      <div className="foot">{account}</div>
      {tip &&
        createPortal(
          <div
            ref={tipRef}
            className="stip sbtip"
            role="tooltip"
            onMouseEnter={() => clearTimeout(tipTimer.current)}
            onMouseLeave={() => hideTip()}
          >
            <b>{tip.t}</b>
            {tip.rows.map(r => (
              <span key={r.k}>
                {r.k} <i className={r.mono ? 'mono' : undefined}>{r.v}</i>
              </span>
            ))}
          </div>,
          document.body,
        )}
      {menu &&
        createPortal(
          <div ref={menuRef} className="pop ctxmenu" role="menu">
            {menuBody()}
          </div>,
          document.body,
        )}
      {flashText &&
        createPortal(
          <div className="flash" role="status" aria-live="polite">
            {flashText}
          </div>,
          document.body,
        )}
    </aside>
  )
}
