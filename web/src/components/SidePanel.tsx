import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { type AgentTask, formatDuration, isFinished, type Tasks } from '../agents'
import { sessionFiles, tilde } from '../files'
import type { ModelOption, Todo } from '../protocol'
import type { SessionChat } from '../store'
import { AgentsTab, type AgentsView, agentTasks, dotClass, WorkflowTab } from './Agents'
import { shortTokens } from './Composer'
import { modelName } from './Message'
import { formatElapsed, modeOf, type T } from './ui'

export type SideTab = 'status' | 'files' | 'agents' | 'workflow' | 'terminals' | 'monitor' | 'bg'

const ofType = (tasks: Tasks, type: string) =>
  Object.values(tasks)
    .filter(task => task.type === type)
    .sort((a, b) => b.seq - a.seq)

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

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown) => (typeof v === 'number' ? v : 0)

/** What Status asks the session for: `get_usage`, `get_memory_dialog` and `get_sandbox_dialog`. */
type StatusData = { usage?: Json; memory?: Json; sandbox?: Json }

function useStatusData(
  sessionId: string,
  live: boolean,
  busy: boolean,
  request?: (body: Json) => Promise<Json>,
): StatusData {
  const [data, setData] = useState<StatusData>({})
  useEffect(() => setData({}), [sessionId])
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
  return data
}

/** `今天 10:02`, or the date for an older session. */
function startedText(at: number, t: T): string {
  const date = new Date(at)
  const time = date.toTimeString().slice(0, 5)
  return date.toDateString() === new Date().toDateString()
    ? t('todayAt', { time })
    : `${date.toLocaleDateString()} ${time}`
}

function usageRows(t: T, chat: SessionChat, usage: Json | undefined): [string, ReactNode][] {
  const session = isObj(usage?.session) ? usage.session : undefined
  const models = isObj(session?.model_usage) ? Object.values(session.model_usage).filter(isObj) : []
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
  return [
    ...(models.length
      ? [
          [
            'tokens',
            t('tokensValue', {
              in: shortTokens(models.reduce((n, m) => n + num(m.inputTokens), 0)),
              out: shortTokens(models.reduce((n, m) => n + num(m.outputTokens), 0)),
              cache: shortTokens(models.reduce((n, m) => n + num(m.cacheReadInputTokens), 0)),
            }),
          ] as [string, ReactNode],
        ]
      : []),
    ...(cost !== undefined ? [[t(subscription ? 'apiPriceLabel' : 'costLabel'), `$${cost.toFixed(2)}`] as [string, ReactNode]] : []),
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
  ]
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
}: {
  t: T
  chat: SessionChat
  title: string
  sessionId: string
  models: ModelOption[]
  statusText: string
  todos: Todo[]
  request?: (body: Json) => Promise<Json>
}) {
  const data = useStatusData(sessionId, chat.mode === 'live', chat.busy, request)
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
  const terminals = ofType(chat.tasks, 'interactive_terminal')
  const monitors = ofType(chat.tasks, 'monitor_mcp')
  const pct = chat.contextPercent === undefined ? undefined : Math.round(chat.contextPercent)
  const account = env.account?.email
    ? [env.account.subscriptionType, env.account.email].filter(Boolean).join(' · ')
    : (env.account?.apiKeySource ?? env.apiKeySource)
  const mcp = env.mcpServers
  return (
    <div className="status-pane">
      <div className="group-h">{t('sessionGroup')}</div>
      <Kv
        rows={[
          [t('nameLabel'), title],
          ['ID', <span className="mono">{`${sessionId.slice(0, 4)}…${sessionId.slice(-4)}`}</span>],
          [
            t('statusLabel'),
            <>
              <span className={`dot ${chat.busy ? 'running' : 'idle'}`} /> {statusText}
            </>,
          ],
          [t('workDir'), <span className="mono">{tilde(chat.cwd ?? chat.workDir ?? '')}</span>],
          [t('roundsLabel'), `${t('roundsValue', { n: String(rounds) })}${compactions ? t('compactedTimes', { n: String(compactions) }) : ''}`],
          ...(chat.startedAt !== undefined ? [[t('startedLabel'), startedText(chat.startedAt, t)] as [string, ReactNode]] : []),
        ]}
      />
      <div className="group-h">{t('modelGroup')}</div>
      <Kv
        rows={[
          [t('modelGroup'), modelName(chat.model, models) ?? '—'],
          [t('effort'), chat.effort ?? '—'],
          [t('permissionModeLabel'), modeOf(chat.permissionMode).label],
          ...(context ? [[t('autoCompactLabel'), t(context.autoCompact ? 'on' : 'off')] as [string, ReactNode]] : []),
        ]}
      />
      <div className="group-h">{t('contextGroup')}</div>
      <div className="usage">
        <div className="ulabel">
          <b>{context ? `${shortTokens(context.total)} / ${shortTokens(context.max)}` : t('contextChip')}</b>
          <span className="mono">{pct === undefined ? '—' : `${pct}%`}</span>
        </div>
        <div className="bar">
          <i style={{ width: `${pct ?? 0}%` }} />
        </div>
        {context?.autoCompact && context.threshold !== undefined && (
          <small>{t('ctxStatusHint', { n: shortTokens(context.max - context.threshold) })}</small>
        )}
      </div>
      {usage.length > 0 && (
        <>
          <div className="group-h">{t('usageGroup')}</div>
          <Kv rows={usage} />
        </>
      )}
      <div className="group-h">{t('goalsGroup')}</div>
      <Kv
        rows={[
          [
            t('goalLabel'),
            chat.goal ? `${chat.goal.condition} · ${t('nChecks', { n: String(chat.goal.iterations) })}` : t('none'),
          ],
          [
            t('todosLabel'),
            todos.length
              ? t('todosDone', { done: String(todos.filter(x => x.status === 'completed').length), total: String(todos.length) })
              : t('none'),
          ],
        ]}
      />
      <div className="group-h">{t('backgroundGroup')}</div>
      <Kv
        rows={[
          ['Agents', t('nRunning', { n: String(runningCount(agents)) })],
          ['Terminals', `${t('nRunning', { n: String(runningCount(terminals)) })} / ${terminals.length}`],
          ['Monitor', t('nRunning', { n: String(runningCount(monitors)) })],
          [
            t('pendingLabel'),
            chat.approvals.length ? t('nRequests', { n: String(chat.approvals.length) }) : t('none'),
          ],
        ]}
      />
      <div className="group-h">{t('envGroup')}</div>
      <Kv
        rows={[
          ...(env.version ? [[t('versionLabel'), <span className="mono">{env.version}</span>] as [string, ReactNode]] : []),
          ...(account ? [[t('accountLabel'), account] as [string, ReactNode]] : []),
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

/** Terminals, Monitor and Background Tasks: one row per task with its status and a stop button. */
function TaskRows({
  t,
  tasks,
  empty,
  tag,
  onStop,
}: {
  t: T
  tasks: AgentTask[]
  empty: string
  tag?: string
  onStop: (id: string) => void
}) {
  if (!tasks.length) return <p className="note">{empty}</p>
  return (
    <div className="tree">
      {tasks.map(task => (
        <div className="node bgrow" key={task.id}>
          <span className="lead">
            <span className={`dot ${dotClass(task.status)}`} />
          </span>
          <span className="name">
            {tag && <span className="tag">{tag}</span>} <span className="mono">{task.description}</span>
          </span>
          <span className={`badge ${dotClass(task.status)}`}>{task.status}</span>
          <span className="meta2">{[formatDuration(task.durationMs), task.summary ?? task.error].filter(Boolean).join(' · ')}</span>
          {!isFinished(task) && (
            <span className="bgact">
              <button className="btn" type="button" onClick={() => onStop(task.id)}>
                {t('stop')}
              </button>
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

/** The right column: Status, Files, Agents, Workflow, Terminals, Monitor, Background Tasks. */
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
  onRequest,
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
  onSendTask: (id: string, text: string) => Promise<string>
  /** A control request to the session; Status reads usage, memory and sandbox with it. */
  onRequest?: (body: Record<string, unknown>) => Promise<Record<string, unknown>>
  todos?: Todo[]
  onClose: () => void
}) {
  const files = useMemo(() => sessionFiles(chat.items).length, [chat.items])
  const agents = Object.keys(agentTasks(chat.tasks)).length
  const terminals = ofType(chat.tasks, 'interactive_terminal')
  const monitors = ofType(chat.tasks, 'monitor_mcp')
  const background = ofType(chat.tasks, 'local_bash')
  const tabs: { id: SideTab; label: string; count?: number }[] = [
    { id: 'status', label: 'Status' },
    { id: 'files', label: 'Files', count: files },
    { id: 'agents', label: 'Agents', count: agents },
    { id: 'workflow', label: 'Workflow' },
    { id: 'terminals', label: 'Terminals', count: terminals.length },
    { id: 'monitor', label: 'Monitor', count: monitors.length },
    { id: 'bg', label: 'Background Tasks', count: background.length },
  ]
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
            request={onRequest}
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
        {tab === 'terminals' && <TaskRows t={t} tasks={terminals} empty={t('noTerminals')} onStop={onStopTask} />}
        {tab === 'monitor' && <TaskRows t={t} tasks={monitors} empty={t('noMonitors')} onStop={onStopTask} />}
        {tab === 'bg' && (
          <TaskRows t={t} tasks={background} empty={t('noBackground')} tag="Bash" onStop={onStopTask} />
        )}
      </div>
    </aside>
  )
}
