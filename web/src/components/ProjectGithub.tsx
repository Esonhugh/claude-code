import { useEffect, useMemo, useRef, useState } from 'react'
import type { GithubIssue, GithubPull, ProjectGithub as GithubSnapshot } from '../../../src/web/projectGithub'
import type { HostRequest } from './BackgroundPanes'
import { Dialog } from './Dialog'
import { ModClient, ModClientSite, type WireNode } from './ModClient'
import type { T } from './ui'
import './ProjectGithub.css'

type Snapshot = GithubSnapshot | { status: 'forbidden' }
type TableRow = { issue?: GithubIssue; pulls: GithubPull[]; title: string }

const PLUGIN = 'github-project'
const MODULE = 'hooks/rows.mjs'

export function githubRows(issues: GithubIssue[], pulls: GithubPull[]): TableRow[] {
  const byIssue = new Map(issues.map(issue => [issue.url, { issue, pulls: [] as GithubPull[], title: issue.title }]))
  const unmatched: TableRow[] = []
  for (const pull of pulls) {
    if (!pull.closingIssues.length) unmatched.push({ pulls: [pull], title: pull.title })
    for (const issue of pull.closingIssues) {
      const row = byIssue.get(issue.url)
      if (row) row.pulls.push(pull)
      else byIssue.set(issue.url, { issue, pulls: [pull], title: issue.title })
    }
  }
  return [...byIssue.values(), ...unmatched]
}

/** Keep the two existing list sections for installed Mods; tableRows is additive. */
export function githubModProps(snapshot: Extract<GithubSnapshot, { status: 'ok' }>, rows: TableRow[], t: T) {
  const legacyRow = ({ number, title, url, state }: GithubIssue | GithubPull) => ({
    number, title, url, label: t(`github_${state}`),
    state: state === 'completed' || state === 'not_planned' || state === 'rejected' ? 'closed' : state,
  })
  const empty = t('githubEmpty')
  return [
    { title: t('githubIssueID'), empty, rows: snapshot.issues.map(legacyRow), tableRows: rows.map(({ issue, pulls, title }) => ({
      issue: issue?.url, pulls: pulls.map(({ url }) => url), title,
    })) },
    { title: t('githubPullID'), empty, rows: snapshot.pulls.map(legacyRow) },
  ]
}

function GithubId({ row, kind, t }: { row: GithubIssue | GithubPull; kind: 'githubIssueID' | 'githubPullID'; t: T }) {
  const number = `#${row.number}`
  const label = t('githubIDState', { kind: t(kind), number, state: t(`github_${row.state}`) })
  const shape = row.state === 'merged' || row.state === 'completed' ? 'accepted' : row.state === 'not_planned' ? 'rejected' : row.state
  return (
    <a className="github-id" href={row.url} target="_blank" rel="noopener noreferrer" aria-label={label} title={label}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" aria-hidden="true" data-state={shape}>
        <circle cx="8" cy="8" r="6.5" strokeDasharray={shape === 'draft' ? '2.6 2.5' : undefined} />
        {shape === 'open' && <circle cx="8" cy="8" r="1.65" fill="currentColor" stroke="none" />}
        {shape === 'accepted' && <path d="m5 8 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />}
        {shape === 'rejected' && <path d="m3.4 12.6 9.2-9.2" />}
        {shape === 'closed' && <path d="M5.2 8h5.6" strokeLinecap="round" />}
      </svg>
      {number}
    </a>
  )
}

export function GithubTable({ rows, t }: { rows: TableRow[]; t: T }) {
  return (
    <table className="github-table" aria-label="GitHub">
      <thead><tr><th scope="col">{t('githubIssueID')}</th><th scope="col">{t('githubPullID')}</th><th scope="col">{t('githubTitle')}</th></tr></thead>
      <tbody>
        {!rows.length && <tr><td colSpan={3} className="note">{t('githubEmpty')}</td></tr>}
        {rows.map(({ issue, pulls, title }) => (
          <tr key={issue?.url ?? pulls[0]?.url}>
            <td>{issue ? <GithubId row={issue} kind="githubIssueID" t={t} /> : '—'}</td>
            <td>{pulls.length ? <div className="github-ids">{pulls.map(pull => (
              <GithubId key={pull.url} row={pull} kind="githubPullID" t={t} />
            ))}</div> : '—'}</td>
            <td>{title}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The optional renderer supplies plain display text. IDs, statuses and table semantics stay host-owned. */
export function githubModRows(tree: WireNode, rows: TableRow[]): TableRow[] | undefined {
  const children = (node: WireNode | undefined, type: 'Box' | 'Text') =>
    typeof node === 'object' && node.type === type ? node.children ?? [] : undefined
  const linksMatch = (cell: WireNode | undefined, urls: string[]) => {
    const links = children(cell, 'Box')
    return links?.length === urls.length && links.every((node, i) => typeof node === 'object' && node.type === 'Link' && node.props?.href === urls[i])
  }
  const modRows = children(tree, 'Box')
  if (modRows?.length !== rows.length) return undefined
  const result: TableRow[] = []
  for (const [i, row] of rows.entries()) {
    const cells = children(modRows[i], 'Box')
    if (cells?.length !== 3 || !linksMatch(cells[0], row.issue ? [row.issue.url] : []) || !linksMatch(cells[1], row.pulls.map(pull => pull.url))) return undefined
    const title = children(cells[2], 'Text')
    if (title?.length !== 1 || typeof title[0] !== 'string') return undefined
    result.push({ ...row, title: title[0] })
  }
  return result
}

export function ProjectGithub({ projectId, t, modRequest }: { projectId: string; t: T; modRequest?: HostRequest }) {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [bundle, setBundle] = useState<Record<string, unknown>>()
  const pending = useRef<AbortController | undefined>(undefined)
  const openingRequest = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => {
    pending.current?.abort()
    openingRequest.current?.abort()
  }, [])
  function close() {
    pending.current?.abort()
    openingRequest.current?.abort()
    openingRequest.current = undefined
    pending.current = undefined
    setOpen(false)
    setBundle(undefined)
    setSnapshot(undefined)
  }
  async function refresh(opening = false) {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setSnapshot(undefined)
    if (opening && modRequest) {
      openingRequest.current = controller
      void modRequest({ subtype: 'ui_client_module', plugin: PLUGIN }).then(result => {
        if (!controller.signal.aborted && result.plugin === PLUGIN && Array.isArray(result.modules)
          && result.modules.some(module => module?.module === MODULE)) setBundle(result)
      }, () => {})
    }
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/github`, { method: 'POST', signal: controller.signal })
      const result: Snapshot = response.ok ? await response.json() : { status: response.status === 403 ? 'forbidden' : 'error' }
      if (!controller.signal.aborted) setSnapshot(result)
    } catch {
      if (!controller.signal.aborted) setSnapshot({ status: 'error' })
    } finally {
      if (pending.current === controller) pending.current = undefined
    }
  }
  // The only session request is for the already loaded Mod's code, never for the project snapshot.
  const site = useMemo(() => bundle && ({
    component: 'Pane', instanceId: PLUGIN,
    request: (body: Record<string, unknown>) => Promise.resolve(body.subtype === 'ui_client_module' && body.plugin === PLUGIN ? bundle : {}),
  }), [bundle])
  const rows = snapshot?.status === 'ok' ? githubRows(snapshot.issues, snapshot.pulls) : undefined
  return (
    <>
      <button type="button" className="btn" onClick={() => { setOpen(true); void refresh(true) }}>GitHub</button>
      {open && <Dialog title="GitHub" t={t} onClose={close}>
        <button type="button" className="btn" disabled={!snapshot} onClick={() => void refresh()}>{t('githubRefresh')}</button>
        {!snapshot && <p className="note" role="status">{t('loading')}</p>}
        {snapshot && snapshot.status !== 'ok' && <p className="note" role="status">{t(`github_${snapshot.status}`)}</p>}
        {rows && snapshot?.status === 'ok' && <>
          <p className="note">{t('githubScope')}</p>
          {site ? (
            <ModClientSite.Provider value={site}>
              <ModClient t={t} readOnlyLinks={new Set(rows.flatMap(({ issue, pulls }) => [...(issue ? [issue.url] : []), ...pulls.map(({ url }) => url)]))}
                fallback={<GithubTable rows={rows} t={t} />}
                renderReadOnlyTree={tree => {
                  const modRows = githubModRows(tree, rows)
                  return modRows && <GithubTable rows={modRows} t={t} />
                }}
                node={{ client: { plugin: PLUGIN }, props: { key: 'github-rows', module: MODULE, props: githubModProps(snapshot, rows, t) } }} />
            </ModClientSite.Provider>
          ) : <GithubTable rows={rows} t={t} />}
        </>}
      </Dialog>}
    </>
  )
}
