import { type ReactNode, useEffect, useRef, useState } from 'react'
import { loadSnippet } from '../api'
import { tilde } from '../files'
import type { ModelOption, SessionEnv } from '../protocol'
import type { HistoryEntry, StartOptions } from '../store'
import { InputBox, ModeItems, ModelMenu, modelButtonLabel } from './Composer'
import { Clawd, FootMenu, modeOf, type T } from './ui'

function greeting(t: T): string {
  const hr = new Date().getHours()
  return t(
    hr < 5
      ? 'greetLate'
      : hr < 11
        ? 'greetMorning'
        : hr < 13
          ? 'greetNoon'
          : hr < 18
            ? 'greetAfternoon'
            : 'greetEvening',
  )
}

const folderName = (dir: string) => dir.split(/[\\/]/).filter(Boolean).at(-1) ?? dir

const snippetCache = new Map<string, string>()

/** The recent cards' snippets (first assistant text), fetched once per session id. */
function useSnippets(ids: string[]): Record<string, string> {
  const [, setVersion] = useState(0)
  const key = ids.join(',')
  useEffect(() => {
    let live = true
    for (const id of key ? key.split(',') : []) {
      if (snippetCache.has(id)) continue
      snippetCache.set(id, '')
      loadSnippet(id).then(
        text => {
          snippetCache.set(id, text)
          if (live) setVersion(v => v + 1)
        },
        () => {},
      )
    }
    return () => {
      live = false
    }
  }, [key])
  return Object.fromEntries(ids.map(id => [id, snippetCache.get(id) ?? '']))
}

/** The new-session page: greeting, big input, folder / mode / model, recent sessions. */
export function StartPage({
  t,
  env,
  options,
  setOptions,
  workspace,
  history,
  tempRoot,
  models,
  draft,
  setDraft,
  files,
  setFiles,
  error,
  trustDir,
  onTrust,
  onCancelTrust,
  onStart,
  onOpen,
  onViewAll,
  menuButton,
}: {
  t: T
  env: SessionEnv
  options: StartOptions
  setOptions: (patch: Partial<StartOptions>) => void
  workspace?: string
  history: HistoryEntry[]
  tempRoot?: string
  models: ModelOption[]
  draft: string
  setDraft: (v: string) => void
  files: File[]
  setFiles: (f: File[]) => void
  error?: string
  /** A folder waiting for the trust confirmation before the session starts. */
  trustDir?: string
  onTrust: () => void
  onCancelTrust: () => void
  onStart: () => void
  onOpen: (entry: HistoryEntry) => void
  onViewAll: () => void
  menuButton: ReactNode
}) {
  const [query, setQuery] = useState('')
  const folderInput = useRef<HTMLInputElement>(null)
  const openTyped = (close: () => void) => {
    const path = query.trim()
    if (!/^(\/|[A-Za-z]:[\\/])/.test(path)) return false
    setOptions({ cwd: path, temporary: false })
    setQuery('')
    close()
    return true
  }
  const isTemp = (dir?: string) => !!tempRoot && !!dir?.startsWith(tempRoot)
  const dirs = [
    ...new Set([workspace, ...history.map(h => h.cwd)].filter((d): d is string => !!d && !isTemp(d))),
  ]
  const cwd = options.cwd ?? workspace
  const shown = dirs.filter(d => !query || d.toLowerCase().includes(query.toLowerCase())).slice(0, 12)
  const recent = history
    .filter(h => (options.temporary ? isTemp(h.cwd) : (h.cwd ?? '') === (cwd ?? '')))
    .slice(0, 3)
  const name = env.account?.email?.split('@')[0]
  const snippets = useSnippets(recent.map(h => h.id))
  const greet = greeting(t)
  return (
    <section className="welcome" aria-label={t('newSession').replace(/^\+\s*/, '')}>
      {menuButton}
      <div className="wl-col">
        <div className="wl-hi">
          <Clawd />
          <span>{name ? t('greetName', { greet, name }) : greet}</span>
        </div>
        {trustDir && (
          <div className="gate" role="alertdialog" aria-label={t('trustTitle')}>
            <b>{t('trustTitle')}</b>
            <span className="note">{t('trustNote', { dir: tilde(trustDir) })}</span>
            <div className="gopts">
              <button className="btn primary" type="button" onClick={onTrust}>
                {t('trustAccept')}
              </button>
              <button className="btn" type="button" onClick={onCancelTrust}>
                {t('cancel')}
              </button>
            </div>
          </div>
        )}
        <InputBox
          t={t}
          start
          busy={false}
          draft={draft}
          setDraft={setDraft}
          onSend={onStart}
          onStop={() => {}}
          files={files}
          setFiles={setFiles}
          skills={env.skills}
        />
        {error && (
          <div className="notice" role="alert">
            {error}
          </div>
        )}
        <div className="wl-bar">
          <FootMenu
            menuClass="pop wl-pick"
            button={
              <>
                <span className="mono">{options.temporary ? '◌' : '⌂'}</span>{' '}
                {options.temporary ? t('temporaryChats') : folderName(cwd ?? '')}{' '}
                <span aria-hidden="true">▾</span>
              </>
            }
          >
            {close => (
              <>
                <input
                  ref={folderInput}
                  placeholder={t('searchOrOpenFolder')}
                  aria-label={t('searchFolder')}
                  autoComplete="off"
                  value={query}
                  autoFocus
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => {
                    // An absolute path opens that folder.
                    if (e.key === 'Enter') openTyped(close)
                  }}
                />
                {shown.map(dir => (
                  <button
                    type="button"
                    role="menuitemradio"
                    key={dir}
                    aria-checked={!options.temporary && dir === cwd}
                    onClick={() => {
                      setOptions({ cwd: dir, temporary: false })
                      close()
                    }}
                  >
                    <span className="mono">⌂</span>
                    <span>
                      {folderName(dir)}
                      <small>{tilde(dir)}</small>
                    </span>
                  </button>
                ))}
                {tempRoot && (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={!!options.temporary}
                    onClick={() => {
                      setOptions({ cwd: undefined, temporary: true })
                      close()
                    }}
                  >
                    <span className="mono">◌</span>
                    <span>
                      {t('temporaryChats')}
                      <small>{t('noFolderHint')}</small>
                    </span>
                  </button>
                )}
                <hr />
                <button
                  type="button"
                  onClick={() => {
                    if (!openTyped(close)) folderInput.current?.focus()
                  }}
                >
                  <span className="mono">+</span>
                  <span>
                    {t('openFolder')}
                    <small>{t('openFolderHint')}</small>
                  </span>
                </button>
              </>
            )}
          </FootMenu>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <FootMenu menuClass="pop wl-pick wl-models" right button={modeOf(options.mode).label}>
              {close => (
                <ModeItems
                  t={t}
                  mode={options.mode}
                  onMode={mode => setOptions({ mode })}
                  close={close}
                />
              )}
            </FootMenu>
            {models.length > 0 && (
              <FootMenu
                menuClass="pop wl-pick wl-models"
                right
                button={modelButtonLabel(options.model ?? 'default', options.effort, models, t)}
              >
                {close => (
                  <ModelMenu
                    t={t}
                    model={options.model ?? 'default'}
                    effort={options.effort}
                    models={models}
                    onModel={model => setOptions({ model })}
                    onEffort={effort => setOptions({ effort })}
                    close={close}
                  />
                )}
              </FootMenu>
            )}
          </span>
        </div>
        <div className="wl-recent">
          <div className="rh">
            <span>{options.temporary ? t('recentTemporary') : t('recentIn', { path: tilde(cwd ?? '') })}</span>
            <button type="button" onClick={onViewAll}>
              {t('viewAll')}
            </button>
          </div>
          {recent.length ? (
            <div className="wl-cards">
              {recent.map(entry => (
                <button type="button" key={entry.id} className="wl-card recent-card" onClick={() => onOpen(entry)}>
                  <span className="sn">{snippets[entry.id] || '…'}</span>
                  <b>{entry.title}</b>
                  <small>
                    {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
                      entry.lastModified,
                    )}
                  </small>
                </button>
              ))}
            </div>
          ) : (
            <p className="note">{t('noSessionsInFolder')}</p>
          )}
        </div>
      </div>
    </section>
  )
}
