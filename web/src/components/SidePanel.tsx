import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { type AgentTask, isFinished } from '../agents'
import { getPeers, getUsage, type Peer } from '../api'
import { type Groups, type Pane, usedPanes } from '../background'
import { sessionFiles, tilde } from '../files'
import type { ModelOption, Todo } from '../protocol'
import type { SessionChat } from '../store'
import { type AgentInput, type AgentPick, AgentsTab, type AgentsView, agentTasks, WorkflowTab } from './Agents'
import { BackgroundPane, type HostRequest, MonitorPane, TerminalsPane, useBackground } from './BackgroundPanes'
import { shortTokens } from './Composer'
import { modelName } from './Message'
import { compactHint, formatElapsed, modeOf, type T } from './ui'

export type SideTab = 'status' | 'files' | 'agents' | 'workflow' | 'terminals' | 'monitor' | 'bg'

const runningCount = (tasks: AgentTask[]) => tasks.filter(task => !isFinished(task)).length

function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The whole session id (what `claude --resume` takes) or messaging address, with a copy button. */
export function SessionIdValue({ id, t }: { id: string; t: T }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(id).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <span className="sid-val">
      <span className="mono">{id}</span>
      <button type="button" aria-label={t(copied ? 'copied' : 'copy')} title={t('copy')} onClick={copy}>
        {copied ? '✓' : '⧉'}
      </button>
    </span>
  )
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown) => (typeof v === 'number' ? v : 0)

/** What Status asks the session for: `get_usage`, `get_memory_dialog`, `get_sandbox_dialog` and `get_status`. */
type StatusData = { usage?: Json; memory?: Json; sandbox?: Json; status?: Json }

/** The CLI /status rows that say where requests go; the rest of /status already has its own Status rows. */
const CONNECTION_LABELS = new Set([
  'Anthropic base URL',
  'OpenAI base URL',
  'Bedrock base URL',
  'Vertex base URL',
  'Microsoft Foundry base URL',
  'AWS region',
  'GCP project',
  'Default region',
  'Microsoft Foundry resource',
  'Proxy',
  'Additional CA cert(s)',
  'mTLS client cert',
  'mTLS client key',
])

/** The labelled text rows of a `get_status` answer. */
function statusRows(status: Json | undefined): [string, string][] {
  const sections = Array.isArray(status?.sections) ? status.sections.filter(isObj) : []
  return sections.flatMap(section =>
    (Array.isArray(section.rows) ? section.rows.filter(isObj) : []).flatMap(row =>
      typeof row.label === 'string' && typeof row.value === 'string'
        ? [[row.label, row.value] as [string, string]]
        : [],
    ),
  )
}

/** Base URL, proxy and the other connection rows of a `get_status` answer. */
export function connectionRows(status: Json | undefined): [string, string][] {
  return statusRows(status).filter(([label]) => CONNECTION_LABELS.has(label))
}

/** The session's `uds:` messaging address (what SendMessage takes), when it has a socket. */
export function peerAddress(status: Json | undefined): string | undefined {
  const value = statusRows(status).find(([label]) => label === 'Peer address')?.[1]
  return value?.startsWith('uds:') ? value : undefined
}

function useStatusData(
  sessionId: string,
  live: boolean,
  busy: boolean,
  request?: (body: Json) => Promise<Json>,
): StatusData {
  const [data, setData] = useState<StatusData>({})
  useEffect(() => setData({}), [sessionId])
  // A session that is not running has no process to ask; its plan limits are this machine's.
  useEffect(() => {
    if (live) return
    let current = true
    getUsage().then(
      body => current && setData(d => ({ ...d, usage: { subscription_type: body.subscription_type, rate_limits: body.rate_limits } as Json })),
      () => {},
    )
    return () => {
      current = false
    }
  }, [sessionId, live])
  useEffect(() => {
    if (!live || busy || !request) return
    let current = true
    const load = (key: keyof StatusData, subtype: string) =>
      request({ subtype }).then(
        body => current && setData(d => ({ ...d, [key]: body })),
        () => {},
      )
    void load('usage', 'get_usage')
    void load('memory', 'get_memory_dialog')
    void load('sandbox', 'get_sandbox_dialog')
    return () => {
      current = false
    }
  }, [sessionId, live, busy, request])
  // Connection settings are fixed for the life of the session process, so one read is enough.
  useEffect(() => {
    if (!live || !request) return
    let current = true
    request({ subtype: 'get_status' }).then(
      body => current && setData(d => ({ ...d, status: body })),
      () => {},
    )
    return () => {
      current = false
    }
  }, [sessionId, live, request])
  return data
}

/** Other live sessions in `cwd`: read again whenever a turn ends, since sessions come and go. */
function usePeers(cwd: string, busy: boolean, own: string | undefined): Peer[] | undefined {
  const [peers, setPeers] = useState<Peer[]>()
  useEffect(() => {
    if (!cwd || busy) return
    let current = true
    getPeers(cwd).then(
      list => current && setPeers(list),
      () => {},
    )
    return () => {
      current = false
    }
  }, [cwd, busy])
  return peers?.filter(p => p.address !== own)
}

/** `今天 10:02`, or the date for an older session. */
function startedText(at: number, t: T): string {
  const date = new Date(at)
  const time = date.toTimeString().slice(0, 5)
  return date.toDateString() === new Date().toDateString()
    ? t('todayAt', { time })
    : `${date.toLocaleDateString()} ${time}`
}

export function usageRows(t: T, chat: SessionChat, usage: Json | undefined): { rows: [string, ReactNode][]; cost?: string } {
  const session = isObj(usage?.session) ? usage.session : undefined
  const models = isObj(session?.model_usage) ? Object.values(session.model_usage).filter(isObj) : []
  const total = (key: string) => shortTokens(models.reduce((n, m) => n + num(m[key]), 0))
  const subscription = !!usage?.subscription_type
  const cost = typeof session?.total_cost_usd === 'number' ? session.total_cost_usd : chat.costUsd
  const limits = isObj(usage?.rate_limits) ? usage.rate_limits : undefined
  const fiveHour = isObj(limits?.five_hour) ? limits.five_hour : undefined
  const streamed = chat.rateLimits.five_hour
  const quota =
    typeof fiveHour?.utilization === 'number'
      ? { pct: fiveHour.utilization, resets: typeof fiveHour.resets_at === 'string' ? Date.parse(fiveHour.resets_at) : NaN }
      : streamed?.utilization !== undefined
        ? { pct: streamed.utilization * 100, resets: (streamed.resetsAt ?? NaN) * 1000 }
        : undefined
  const sevenDay = isObj(limits?.seven_day) ? limits.seven_day : undefined
  const weekResets = typeof sevenDay?.resets_at === 'string' ? Date.parse(sevenDay.resets_at) : NaN
  const costText = cost === undefined ? undefined : `$${cost.toFixed(2)}`
  const rows: [string, ReactNode][] = [
    ...(models.length
      ? [
          ['tokens', t('tokensValue', { in: total('inputTokens'), out: total('outputTokens') })] as [string, ReactNode],
          [
            t('cacheLabel'),
            t('cacheValue', { read: total('cacheReadInputTokens'), write: total('cacheCreationInputTokens') }),
          ] as [string, ReactNode],
        ]
      : []),
    ...(costText ? [[t(subscription ? 'apiPriceLabel' : 'costLabel'), costText] as [string, ReactNode]] : []),
    ...(typeof session?.total_api_duration_ms === 'number' && session.total_api_duration_ms > 0
      ? [[t('apiDurationLabel'), formatElapsed(session.total_api_duration_ms)] as [string, ReactNode]]
      : []),
    ...(quota
      ? [
          [
            t('quota5hLabel'),
            t('quotaValue', {
              pct: String(Math.round(quota.pct)),
              time: Number.isFinite(quota.resets) ? new Date(quota.resets).toTimeString().slice(0, 5) : '—',
            }),
          ] as [string, ReactNode],
        ]
      : []),
    ...(typeof sevenDay?.utilization === 'number'
      ? [
          [
            t('quotaWeekLabel'),
            t('quotaValue', {
              pct: String(Math.round(sevenDay.utilization)),
              time: Number.isFinite(weekResets)
                ? new Date(weekResets).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
                : '—',
            }),
          ] as [string, ReactNode],
        ]
      : []),
  ]
  return { rows, cost: costText }
}

const PROVIDER_NAMES: Record<string, string> = { bedrock: 'Amazon Bedrock', vertex: 'Google Vertex AI', foundry: 'Microsoft Foundry' }

/** The account line: plan and email for a sign-in, else where the key comes from in words. */
export function accountText(t: T, env: SessionChat['env']): string | undefined {
  const account = env.account
  if (account?.email) return [account.subscriptionType, account.email].filter(Boolean).join(' · ')
  const provider = account?.apiProvider && PROVIDER_NAMES[account.apiProvider]
  if (provider) return provider
  const source = account?.apiKeySource ?? env.apiKeySource
  if (!source || source === 'none') return undefined
  if (source === 'ANTHROPIC_API_KEY') return t('keyFromEnv')
  if (source === '/login managed key') return t('keyFromLogin')
  return `API key · ${source}`
}

/** Status offers `/compact` by itself once the context is this full. */
export const SUGGEST_COMPACT_PERCENT = 60

/** A Status section that folds; `summary` stays visible when folded. */
function Section({ title, summary, open, children }: { title: string; summary?: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="sgroup" open={open}>
      <summary>
        <span>{title}</span>
        {summary && <small>{summary}</small>}
      </summary>
      {children}
    </details>
  )
}

function StatusPane({
  t,
  chat,
  title,
  sessionId,
  models,
  statusText,
  todos,
  request,
  groups,
  onCompact,
}: {
  t: T
  chat: SessionChat
  title: string
  sessionId: string
  models: ModelOption[]
  statusText: string
  todos: Todo[]
  request?: (body: Json) => Promise<Json>
  groups: Groups
  onCompact?: () => void
}) {
  const data = useStatusData(sessionId, chat.mode === 'live', chat.busy, request)
  // The socket lives only as long as the session process.
  const peer = chat.mode === 'live' ? peerAddress(data.status) : undefined
  const cwd = chat.cwd ?? chat.workDir ?? ''
  const allPeers = usePeers(cwd, chat.busy, peer)
  // Until get_status names this session's own socket, the list would still include the session itself.
  const peers = chat.mode === 'live' && !data.status ? undefined : allPeers
  const rounds = chat.items.filter(i => i.kind === 'user').length
  const compactions = chat.items.filter(i => i.kind === 'compact').length
  const context = chat.context
  const usage = usageRows(t, chat, data.usage)
  const instructions = Array.isArray(data.memory?.files)
    ? data.memory.files.filter(f => isObj(f) && f.exists === true && typeof f.path === 'string').map(f => tilde((f as Json).path as string))
    : undefined
  const autoMemory = isObj(data.memory?.auto_memory) ? data.memory.auto_memory.enabled === true : undefined
  const memories = Array.isArray(data.memory?.memories) ? data.memory.memories.filter(m => isObj(m) && m.name !== 'MEMORY.md').length : 0
  const env = chat.env
  const agents = Object.values(agentTasks(chat.tasks))
  const { terminals, monitors, background } = groups
  const running = runningCount(agents) + runningCount(terminals) + runningCount(monitors) + runningCount(background)
  const pct = chat.contextPercent === undefined ? undefined : Math.round(chat.contextPercent)
  const suggestCompact = !!onCompact && pct !== undefined && pct >= SUGGEST_COMPACT_PERCENT
  const account = accountText(t, env)
  const mcp = env.mcpServers
  const roundsText = `${t('roundsValue', { n: String(rounds) })}${compactions ? t('compactedTimes', { n: String(compactions) }) : ''}`
  const todosText = todos.length
    ? t('todosDone', { done: String(todos.filter(x => x.status === 'completed').length), total: String(todos.length) })
    : t('none')
  return (
    <div className="status-pane">
      <div className="status-top">
        <div className="st-state">
          <span className={`dot ${chat.busy ? 'running' : 'idle'}`} />
          <b>{statusText}</b>
          <small>{roundsText}</small>
        </div>
        <div className="st-model">
          {[modelName(chat.model, models) ?? '—', chat.effort, modeOf(chat.permissionMode).label].filter(Boolean).join(' · ')}
        </div>
        <div className="usage">
          <div className="ulabel">
            <b>
              {t('contextGroup')} {context ? `${shortTokens(context.total)} / ${shortTokens(context.max)}` : ''}
            </b>
            <span className="mono">{pct === undefined ? '—' : `${pct}%`}</span>
          </div>
          <div className="bar">
            <i style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
          </div>
          {(context || suggestCompact) && (
            <div className="st-compact">
              {context && (
                <small>
                  {context.autoCompact && context.threshold !== undefined
                    ? compactHint(t, context.total, context.threshold, shortTokens)
                    : `${t('autoCompactLabel')} ${t('off')}`}
                </small>
              )}
              {suggestCompact && (
                <button type="button" className="btn" disabled={chat.busy} onClick={onCompact}>
                  {t('compactNow')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {usage.rows.length > 0 && (
        <Section title={t('usageGroup')} summary={usage.cost} open>
          <Kv rows={usage.rows} />
        </Section>
      )}
      <Section title={t('backgroundGroup')} summary={running ? t('nRunning', { n: String(running) }) : t('none')} open>
        <Kv
          rows={[
            ['Agents', `${t('nRunning', { n: String(runningCount(agents)) })} / ${agents.length}`],
            ['Terminals', `${t('nRunning', { n: String(runningCount(terminals)) })} / ${terminals.length}`],
            ['Monitor', `${t('nRunning', { n: String(runningCount(monitors)) })} / ${monitors.length}`],
            ['Background', `${t('nRunning', { n: String(runningCount(background)) })} / ${background.length}`],
            [
              t('pendingLabel'),
              chat.approvals.length ? t('nRequests', { n: String(chat.approvals.length) }) : t('none'),
            ],
          ]}
        />
      </Section>
      <Section title={t('goalsGroup')} summary={chat.goal ? chat.goal.condition : todosText}>
        <Kv
          rows={[
            [
              t('goalLabel'),
              chat.goal ? `${chat.goal.condition} · ${t('nChecks', { n: String(chat.goal.iterations) })}` : t('none'),
            ],
            [t('todosLabel'), todosText],
          ]}
        />
      </Section>
      <Section title={t('sessionGroup')} summary={title}>
        <Kv
          rows={[
            [t('nameLabel'), title],
            ['ID', <SessionIdValue id={sessionId} t={t} />],
            [t('workDir'), <span className="mono">{tilde(cwd)}</span>],
            ...(peer ? [[t('peerAddressLabel'), <SessionIdValue id={peer} t={t} />] as [string, ReactNode]] : []),
            [t('roundsLabel'), roundsText],
            ...(chat.startedAt !== undefined ? [[t('startedLabel'), startedText(chat.startedAt, t)] as [string, ReactNode]] : []),
            ...(context ? [[t('autoCompactLabel'), t(context.autoCompact ? 'on' : 'off')] as [string, ReactNode]] : []),
          ]}
        />
      </Section>
      <Section title={t('envGroup')} summary={account}>
        <Kv
          rows={[
            ...(env.version ? [[t('versionLabel'), <span className="mono">{env.version}</span>] as [string, ReactNode]] : []),
            ...(account ? [[t('accountLabel'), account] as [string, ReactNode]] : []),
            ...(peers
              ? [
                  [
                    t('peersLabel'),
                    peers.length ? (
                      <div className="peers">
                        {peers.map(p => (
                          <div key={p.address}>
                            <span>
                              {p.name} <small>[{p.ref}]{p.status ? ` · ${p.status}` : ''}</small>
                            </span>
                            <SessionIdValue id={p.address} t={t} />
                          </div>
                        ))}
                      </div>
                    ) : (
                      t('none')
                    ),
                  ] as [string, ReactNode],
                ]
              : []),
            ...connectionRows(data.status).map(
              ([label, value]) => [label, <span className="mono">{value}</span>] as [string, ReactNode],
            ),
            ...(mcp
              ? [
                  [
                    'MCP',
                    t('connectedOf', {
                      n: String(mcp.filter(m => m.status === 'connected').length),
                      total: String(mcp.length),
                    }),
                  ] as [string, ReactNode],
                ]
              : []),
            ...(instructions?.length
              ? [[t('instructionsLabel'), instructions.join(' · ')] as [string, ReactNode]]
              : []),
            ...(autoMemory !== undefined
              ? [[t('memoryLabel'), autoMemory ? t('memoryOn', { n: String(memories) }) : t('memoryOff')] as [string, ReactNode]]
              : []),
            ...(data.sandbox
              ? [[t('sandboxLabel'), data.sandbox.enabled === true ? t('sandboxOn') : t('sandboxOff')] as [string, ReactNode]]
              : []),
            ...(env.hooks
              ? [
                  [
                    'Hooks',
                    `${env.hooks.length}${env.hooks.length ? `（${[...new Set(env.hooks.map(h => h.event))].join(', ')}）` : ''}`,
                  ] as [string, ReactNode],
                ]
              : []),
          ]}
        />
      </Section>
    </div>
  )
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
const dirName = (path: string) => path.slice(0, Math.max(0, path.length - baseName(path).length - 1))
const kindOf = (path: string) => {
  const ext = baseName(path).split('.').at(-1) ?? ''
  return ext && ext !== baseName(path) ? ext.toUpperCase().slice(0, 4) : '—'
}

function FilesPane({
  t,
  chat,
  current,
  onOpen,
}: {
  t: T
  chat: SessionChat
  current?: string
  onOpen: (path: string) => void
}) {
  const files = useMemo(() => sessionFiles(chat.items), [chat.items])
  if (!files.length) return <p className="note">{t('noFiles')}</p>
  return (
    <div className="filelist" style={{ maxHeight: 'none' }}>
      {files.map(f => (
        <button
          type="button"
          className="filerow"
          key={f.path}
          aria-current={f.path === current}
          title={f.path}
          onClick={() => onOpen(f.path)}
        >
          <span className="kind mono">{kindOf(f.path)}</span>
          <span className="fn">
            <b>{baseName(f.path)}</b>
            <small className="mono">{dirName(f.path)}</small>
          </span>
          <span className="fmeta">
            <span className={`tag src-${f.source}`}>{t(f.source)}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

/**
 * The right column: Status, Files and Agents always; Workflow, Terminals,
 * Monitor and Background Tasks once the session has used them (or one is open).
 */
export function SidePanel({
  t,
  open,
  tab,
  setTab,
  sessionId,
  chat,
  title,
  models,
  statusText,
  currentFile,
  agentsView,
  setAgentsView,
  workflowId,
  setWorkflowId,
  onOpenFile,
  onStopTask,
  onSendTask,
  agentInput,
  onRequest,
  onStatusRequest,
  onCompact,
  todos = [],
  onClose,
}: {
  t: T
  open: boolean
  tab: SideTab
  setTab: (tab: SideTab) => void
  sessionId: string
  chat: SessionChat
  title: string
  models: ModelOption[]
  statusText: string
  currentFile?: string
  agentsView: AgentsView
  setAgentsView: (view: AgentsView) => void
  workflowId?: string
  setWorkflowId: (id: string | undefined) => void
  onOpenFile: (path: string) => void
  onStopTask: (id: string) => void
  onSendTask: (id: string, text: string, pick: AgentPick) => Promise<void>
  /** The palette, files, mode and model an agent's input box shares with the session's. */
  agentInput: AgentInput
  /** A control request to the session; Status reads usage, memory and sandbox with it. */
  onStatusRequest?: HostRequest
  /** Sends `/compact`; Status shows the button once the context passes SUGGEST_COMPACT_PERCENT. */
  onCompact?: () => void
  todos?: Todo[]
  onRequest: HostRequest
  onClose: () => void
}) {
  const files = useMemo(() => sessionFiles(chat.items).length, [chat.items])
  const agents = Object.keys(agentTasks(chat.tasks)).length
  const bg = useBackground(sessionId, chat.tasks, ['terminals', 'monitor', 'bg'].includes(tab), onRequest)
  const { terminals, monitors, background } = bg.groups
  const used = useMemo(() => usedPanes(chat.tasks, chat.items, bg.groups), [chat.tasks, chat.items, bg.groups])
  const tabs = (
    [
      { id: 'status', label: 'Status' },
      { id: 'files', label: 'Files', count: files },
      { id: 'agents', label: 'Agents', count: agents },
      { id: 'workflow', label: 'Workflow' },
      { id: 'terminals', label: 'Terminals', count: terminals.length },
      { id: 'monitor', label: 'Monitor', count: monitors.length },
      { id: 'bg', label: 'Background Tasks', count: background.length },
    ] satisfies { id: SideTab; label: string; count?: number }[]
  ).filter(x => ['status', 'files', 'agents', tab].includes(x.id) || used.includes(x.id as Pane))
  return (
    <aside className={`side${open ? ' open' : ''}`} aria-label={t('sidebarLabel')}>
      <div className="sheet-head">
        <span>{t('panel')}</span>
        <button className="btn" type="button" onClick={onClose}>
          {t('close')}
        </button>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map(x => (
          <button
            role="tab"
            type="button"
            key={x.id}
            aria-selected={tab === x.id}
            onClick={() => {
              setTab(x.id)
              if (x.id === 'agents') setAgentsView({ kind: 'tree' })
            }}
          >
            {x.label}
            {!!x.count && <span className="count">{x.count}</span>}
          </button>
        ))}
      </div>
      <div className="pane" role="tabpanel">
        {tab === 'status' && (
          <StatusPane
            t={t}
            chat={chat}
            title={title}
            sessionId={sessionId}
            models={models}
            statusText={statusText}
            todos={todos}
            request={onStatusRequest}
            groups={bg.groups}
            onCompact={onCompact}
          />
        )}
        {tab === 'files' && <FilesPane t={t} chat={chat} current={currentFile} onOpen={onOpenFile} />}
        {tab === 'agents' && (
          <AgentsTab
            sessionId={sessionId}
            tasks={chat.tasks}
            items={chat.items}
            busy={chat.busy}
            view={agentsView}
            setView={setAgentsView}
            onWorkflow={id => {
              setWorkflowId(id)
              setTab('workflow')
            }}
            onStop={onStopTask}
            onSend={onSendTask}
            input={agentInput}
            t={t}
          />
        )}
        {tab === 'workflow' && (
          <WorkflowTab
            sessionId={sessionId}
            tasks={chat.tasks}
            selectedId={workflowId}
            setSelectedId={setWorkflowId}
            onStop={onStopTask}
            t={t}
          />
        )}
        {tab === 'terminals' && (
          <TerminalsPane
            t={t}
            tasks={chat.tasks}
            groups={bg.groups}
            details={bg.details}
            screens={bg.screens}
            refreshScreen={bg.refreshScreen}
            request={onRequest}
            onStop={onStopTask}
          />
        )}
        {tab === 'monitor' && (
          <MonitorPane t={t} tasks={chat.tasks} groups={bg.groups} details={bg.details} onStop={onStopTask} />
        )}
        {tab === 'bg' && (
          <BackgroundPane t={t} tasks={chat.tasks} groups={bg.groups} details={bg.details} onStop={onStopTask} />
        )}
      </div>
    </aside>
  )
}
