import { type ReactNode, useMemo } from 'react'
import { type AgentTask, formatDuration, isFinished, type Tasks } from '../agents'
import { sessionFiles } from '../files'
import type { ModelOption } from '../protocol'
import type { SessionChat } from '../store'
import { AgentsTab, type AgentsView, agentTasks, dotClass, WorkflowTab } from './Agents'
import { modelName } from './Message'
import { modeOf, type T } from './ui'

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

function StatusPane({
  t,
  chat,
  title,
  sessionId,
  models,
  statusText,
}: {
  t: T
  chat: SessionChat
  title: string
  sessionId: string
  models: ModelOption[]
  statusText: string
}) {
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
          [t('workDir'), <span className="mono">{chat.cwd ?? chat.workDir ?? ''}</span>],
        ]}
      />
      <div className="group-h">{t('modelGroup')}</div>
      <Kv
        rows={[
          [t('modelGroup'), modelName(chat.model, models) ?? '—'],
          [t('effort'), chat.effort ?? '—'],
          [t('permissionModeLabel'), modeOf(chat.permissionMode).label],
        ]}
      />
      <div className="group-h">{t('contextGroup')}</div>
      <div className="usage">
        <div className="ulabel">
          <b>{t('contextChip')}</b>
          <span className="mono">{pct === undefined ? '—' : `${pct}%`}</span>
        </div>
        <div className="bar">
          <i style={{ width: `${pct ?? 0}%` }} />
        </div>
      </div>
      {chat.costUsd !== undefined && (
        <>
          <div className="group-h">{t('usageGroup')}</div>
          <Kv rows={[[t('costLabel'), `$${chat.costUsd.toFixed(2)}`]]} />
        </>
      )}
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
          <StatusPane t={t} chat={chat} title={title} sessionId={sessionId} models={models} statusText={statusText} />
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
