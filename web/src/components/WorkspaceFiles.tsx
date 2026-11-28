import { useEffect, useState } from 'react'
import { ApiError, listWorkspaceTree, type FileTreeScope, type ProjectTree } from '../api'
import type { T } from './ui'

type TreeProps = { scope: FileTreeScope; cache: Map<string, ProjectTree>; t: T }

function Branch({ scope: { kind, id }, cache, t, dir }: TreeProps & { dir: string }) {
  const [page, setPage] = useState(() => cache.get(dir))
  const [error, setError] = useState<'workspaceFilesUnavailable' | 'workspaceFilesError'>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (cache.has(dir)) return
    const abort = new AbortController()
    void listWorkspaceTree({ kind, id }, dir, abort.signal).then(result => {
      if (abort.signal.aborted) return
      cache.set(dir, result)
      setPage(result)
    }, (err: unknown) => {
      if (!abort.signal.aborted) {
        setError(err instanceof ApiError && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status) ? 'workspaceFilesUnavailable' : 'workspaceFilesError')
      }
    })
    return () => abort.abort()
  }, [kind, id, cache, dir, attempt])

  if (error) return (
    <div className="workspace-files-note" role="status">
      {t(error)}{' '}
      {error === 'workspaceFilesError' && (
        <button className="footbtn" type="button" onClick={() => { setError(undefined); setAttempt(n => n + 1) }}>{t('retry')}</button>
      )}
    </div>
  )
  if (!page) return <p className="workspace-files-note" role="status">{t('loading')}</p>
  return (
    <>
      {page.entries.length > 0 && (
        <ul>
          {page.entries.map(entry => (
            entry.type === 'directory'
              ? <Directory key={entry.name} scope={{ kind, id }} cache={cache} t={t} dir={dir ? `${dir}/${entry.name}` : entry.name} name={entry.name} />
              : <li className="workspace-file" key={entry.name}><bdi>{entry.name}</bdi></li>
          ))}
        </ul>
      )}
      {page.truncated
        ? <p className="workspace-files-note">{t('workspaceFilesTruncated')}</p>
        : !page.entries.length && <p className="workspace-files-note">{t('workspaceFilesEmpty')}</p>}
    </>
  )
}

function Directory({ name, dir, ...tree }: TreeProps & { name: string; dir: string }) {
  const [open, setOpen] = useState(false)
  return (
    <li>
      <button type="button" className="workspace-directory" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> <bdi>{name}</bdi>
      </button>
      {open && <Branch {...tree} dir={dir} />}
    </li>
  )
}

/** Remount on scope or session lifecycle changes, discarding names and pending requests. */
export function WorkspaceFiles({ scope, supported, sessionMode, t }: { scope?: FileTreeScope; supported?: boolean; sessionMode?: string; t: T }) {
  if (!supported || !scope) return null
  const lifecycle = scope.kind === 'session' ? `:${sessionMode ?? ''}` : ''
  return <ScopedFiles key={`${scope.kind}:${scope.id}${lifecycle}`} scope={scope} t={t} />
}

function ScopedFiles({ scope, t }: { scope: FileTreeScope; t: T }) {
  const [open, setOpen] = useState(false)
  const [cache] = useState(() => new Map<string, ProjectTree>())
  return (
    <section className="workspace-files">
      <div className="sb-h">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          {t('sbWorkspaceFiles')}
        </button>
      </div>
      {open && (
        <div className="workspace-files-body">
          {scope.kind === 'session' && <p className="workspace-files-note">{t('sbWorkspaceStartupCwd')}</p>}
          <Branch scope={scope} cache={cache} t={t} dir="" />
        </div>
      )}
    </section>
  )
}
