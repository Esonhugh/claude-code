import { open } from 'fs/promises'
import { join } from 'path'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { Clawd } from '../components/LogoV2/Clawd.js'
import { getConfiguredUiName } from '../components/LogoV2/uiName.js'
import {
  hostRequest,
  type JobRecord,
  listJobs,
  stopJob,
} from '../daemon/protocol.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { stringWidth } from '../ink/stringWidth.js'
import { AlternateScreen } from '../ink/components/AlternateScreen.js'
import { Box, createRoot, Text, useInput } from '../ink.js'
import { getDisplayedEffortLevel } from '../utils/effort.js'
import { truncate } from '../utils/format.js'
import { getMainLoopModel, parseUserSpecifiedModel, renderModelSetting } from '../utils/model/model.js'
import {
  getModeColor,
  permissionModeFromString,
  permissionModeSymbol,
  permissionModeTitle,
} from '../utils/permissions/PermissionMode.js'
import { getBaseRenderOptions } from '../utils/renderOptions.js'
import { getProjectDir } from '../utils/sessionStoragePortable.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { listAllLiveSessions } from '../utils/udsClient.js'
import {
  attachToJob,
  type KeptWorktree,
  keptWorktreeLines,
  removeJob,
  respawnJob,
  spawnBackgroundSession,
} from './bg.js'

const REFRESH_MS = 1500
const TAIL_BYTES = 256 * 1024

type Group = 'needs' | 'working' | 'completed'

const GROUP_TITLES: Record<Group, string> = {
  needs: 'Needs you',
  working: 'Working',
  completed: 'Completed',
}

type Row = { job: JobRecord; group: Group; detail: string }

type Action = { type: 'quit' } | { type: 'open'; id: string }

/** The first line of the session's latest response, read from its transcript tail. */
async function lastResponse(job: JobRecord): Promise<string | undefined> {
  const dir = job.worktree?.worktreePath ?? job.cwd
  const file = await open(join(getProjectDir(dir), `${job.sessionId}.jsonl`), 'r').catch(() => null)
  if (!file) return undefined
  try {
    const { size } = await file.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await file.read(buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!
      if (!line.includes('"type":"assistant"')) continue
      try {
        const record = JSON.parse(line) as { message?: { content?: { type: string; text?: string }[] } }
        const text = record.message?.content?.find(block => block.type === 'text')?.text?.trim()
        if (text) return text.split('\n')[0]
      } catch {
        // A line cut by the tail window.
      }
    }
    return undefined
  } finally {
    await file.close()
  }
}

async function loadRows(cwd: string | undefined): Promise<Row[]> {
  const [jobs, live] = await Promise.all([listJobs(), listAllLiveSessions()])
  const status = new Map(live.map(session => [session.sessionId, session.status]))
  const rows = await Promise.all(
    jobs
      .filter(job => !cwd || job.cwd.startsWith(cwd))
      .map(async (job): Promise<Row> => {
        const group: Group =
          job.state !== 'running' ? 'completed' : status.get(job.sessionId) === 'waiting' ? 'needs' : 'working'
        const response = await lastResponse(job)
        const detail = job.state === 'running' ? (response ?? 'starting…') : job.state
        return { job, group, detail }
      }),
  )
  const order: Group[] = ['needs', 'working', 'completed']
  return rows.sort(
    (a, b) => order.indexOf(a.group) - order.indexOf(b.group) || b.job.createdAt.localeCompare(a.job.createdAt),
  )
}

function formatAge(since: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

function keptRowText(kept: KeptWorktree): string {
  if (kept.reason === 'remove_failed') {
    if (kept.withheld === 'tracked_changes')
      return 'worktree not removed, and it has uncommitted changes — commit or stash them, then ctrl+x again'
    if (kept.withheld === 'not_registered') return 'worktree not removed — remove the directory yourself, then ctrl+x again'
    return kept.forceFailed
      ? "couldn't delete the worktree directory — ctrl+x again retries"
      : "git couldn't remove the worktree — ctrl+x again deletes it anyway"
  }
  return kept.reason === 'uncommitted'
    ? 'uncommitted changes — ctrl+x again discards them'
    : `${kept.detail} — ctrl+x again discards them`
}

function AgentRow({
  row,
  detail,
  nameWidth,
  width,
  selected,
}: {
  row: Row
  detail: string
  nameWidth: number
  width: number
  selected: boolean
}): React.ReactNode {
  const icon = row.group === 'completed' ? '∙' : row.group === 'needs' ? '!' : '✻'
  const age = formatAge(row.job.createdAt)
  const name = truncate(row.job.name, nameWidth).padEnd(nameWidth)
  const detailWidth = Math.max(0, width - nameWidth - stringWidth(age) - 7)
  const shown = truncate(detail, detailWidth)
  const gap = ' '.repeat(Math.max(1, detailWidth - stringWidth(shown) + 1))
  return (
    <Text backgroundColor={selected ? 'userMessageBackground' : undefined} wrap="truncate-end">
      {' '}
      <Text color={row.group === 'needs' ? 'warning' : undefined} dimColor={row.group !== 'needs'}>
        {icon}
      </Text>{' '}
      <Text dimColor={!selected} bold={selected}>
        {name}
      </Text>
      {'  '}
      <Text dimColor>{shown}</Text>
      {gap}
      <Text dimColor>{age}</Text>
    </Text>
  )
}

function InputLine({ value, placeholder }: { value: string; placeholder: string }): React.ReactNode {
  return (
    <Text>
      {'❯ '}
      {value ? (
        <Text>
          {value}
          <Text inverse> </Text>
        </Text>
      ) : (
        <Text dimColor>
          <Text inverse>{placeholder[0]}</Text>
          {placeholder.slice(1)}
        </Text>
      )}
    </Text>
  )
}

/** What `claude agents` options set for the sessions it dispatches. */
export type Dispatch = {
  flags: string[]
  model?: string
  effort?: string
  permissionMode?: string
  agent?: string
  allowBypass?: boolean
}

/** The footer's summary of non-default dispatch options, like 2.1.311. */
function DispatchDefaults({ dispatch }: { dispatch: Dispatch }): React.ReactNode {
  const mode = dispatch.permissionMode ? permissionModeFromString(dispatch.permissionMode) : 'default'
  const parts: React.ReactNode[] = []
  if (mode !== 'default') {
    parts.push(
      <Text key="mode" color={getModeColor(mode)}>
        {permissionModeSymbol(mode)} {permissionModeTitle(mode).toLowerCase()}
      </Text>,
    )
  } else if (dispatch.allowBypass) {
    parts.push(
      <Text key="bypass" color={getModeColor('bypassPermissions')}>
        {permissionModeSymbol('bypassPermissions')} bypass available
      </Text>,
    )
  }
  if (dispatch.agent) parts.push(`@${dispatch.agent}`)
  if (dispatch.model) parts.push(dispatch.model)
  if (dispatch.effort) parts.push(dispatch.effort)
  return parts.map((part, i) => <React.Fragment key={i}>{part} · </React.Fragment>)
}

function AgentView({
  cwd,
  dispatch,
  initialFocus,
  cameFrom,
  onAction,
}: {
  cwd: string | undefined
  dispatch: Dispatch
  initialFocus: string | undefined
  cameFrom: string | undefined
  onAction: (action: Action) => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [focusId, setFocusId] = useState(initialFocus)
  const [input, setInput] = useState('')
  const [reply, setReply] = useState<{ id: string; text: string } | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [armed, setArmed] = useState<string | null>(null)
  const [kept, setKept] = useState<Record<string, KeptWorktree>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    void loadRows(cwd).then(next => {
      if (!cancelled) setRows(next)
    })
    const timer = setTimeout(() => setTick(t => t + 1), REFRESH_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [cwd, tick])

  const list = rows ?? []
  const focusIndex = Math.max(0, list.findIndex(row => row.job.id === focusId))
  const focused = list[focusIndex]
  const refresh = () => setTick(t => t + 1)

  const deleteFocused = async (row: Row) => {
    const { job } = row
    if (armed !== job.id) {
      setArmed(job.id)
      if (job.state === 'running') {
        await stopJob(job)
        refresh()
      }
      return
    }
    const result = await removeJob(job, kept[job.id]?.discard, kept[job.id]?.forceRemove)
    if (result.kept) {
      setKept(k => ({ ...k, [job.id]: result.kept! }))
      setNotice(keptWorktreeLines(result.kept, job.id)[0]!)
      return
    }
    // Keep the cursor where the deleted row was.
    const next = list[focusIndex + 1] ?? list[focusIndex - 1]
    setFocusId(next?.job.id)
    setArmed(null)
    setNotice(null)
    refresh()
  }

  const sendReply = async (row: Row, text: string) => {
    if (row.job.state !== 'running' || !row.job.ptySock) {
      setNotice(`${row.job.id} is not running · enter to open it`)
      return
    }
    // The prompt reads a single chunk as a paste, so submit separately.
    await hostRequest(row.job.ptySock, { type: 'input', data: Buffer.from(text).toString('base64') })
    await new Promise(resolve => setTimeout(resolve, 50))
    await hostRequest(row.job.ptySock, { type: 'input', data: Buffer.from('\r').toString('base64') })
    setReply(null)
    refresh()
  }

  const createSession = async (prompt: string) => {
    try {
      const job = await spawnBackgroundSession({
        cwd: process.cwd(),
        flags: dispatch.flags,
        prompt,
        origin: `transient — started on-demand by \`claude agents\` (pid ${process.pid}) in ${process.cwd()}`,
      })
      setFocusId(job.id)
      setNotice(null)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
    refresh()
  }

  useInput((char, key) => {
    if (!(key.ctrl && char === 'x')) setArmed(null)
    if (key.ctrl && char === 'c') {
      if (input) setInput('')
      else onAction({ type: 'quit' })
      return
    }
    if (key.escape) {
      if (helpOpen) setHelpOpen(false)
      else if (reply) setReply(null)
      else if (input) setInput('')
      else onAction({ type: 'quit' })
      return
    }
    if (key.ctrl && char === 'x') {
      if (focused) void deleteFocused(focused)
      return
    }
    if (reply) {
      if (key.return) {
        if (reply.text.trim() && focused) void sendReply(focused, reply.text)
        else if (focused) onAction({ type: 'open', id: focused.job.id })
      } else if (key.backspace || key.delete) {
        setReply({ ...reply, text: reply.text.slice(0, -1) })
      } else if (char === ' ' && !reply.text) {
        setReply(null)
      } else if (char && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
        setReply({ ...reply, text: reply.text + char })
      }
      return
    }
    if (key.upArrow || key.downArrow) {
      const next = list[Math.min(list.length - 1, Math.max(0, focusIndex + (key.upArrow ? -1 : 1)))]
      if (next) setFocusId(next.job.id)
      setNotice(null)
      return
    }
    if (key.return) {
      if (input.trim()) {
        const prompt = input.trim()
        setInput('')
        void createSession(prompt)
      } else if (focused) {
        onAction({ type: 'open', id: focused.job.id })
      }
      return
    }
    if (key.backspace || key.delete) {
      setInput(value => value.slice(0, -1))
      return
    }
    if (!input && char === '?') {
      setHelpOpen(open => !open)
      return
    }
    if (!input && char === ' ' && focused) {
      setReply({ id: focused.job.id, text: '' })
      return
    }
    if (char && !key.ctrl && !key.meta && !key.tab) setInput(value => value + char)
  })

  const counts = { needs: 0, working: 0, completed: 0 }
  for (const row of list) counts[row.group]++
  const settings = getInitialSettings()
  const model = dispatch.model ? parseUserSpecifiedModel(dispatch.model) : getMainLoopModel()
  const nameWidth = Math.min(30, Math.max(4, ...list.map(row => stringWidth(row.job.name))))

  const detailFor = (row: Row) => {
    if (kept[row.job.id] && armed === row.job.id) return keptRowText(kept[row.job.id]!)
    if (armed === row.job.id) return `${row.job.state === 'running' ? 'stopping' : row.detail} · ctrl+x again to delete`
    return row.detail
  }

  let hint: string
  if (armed) hint = 'ctrl+x to confirm'
  else if (reply) hint = reply.text ? 'enter to send · esc to close · ctrl+x to delete' : 'enter to open · space to close · ctrl+x to delete'
  else if (input) hint = 'enter to create · esc to clear'
  else if (!focused) hint = 'enter to create · ? for shortcuts · esc to quit'
  else hint = `${focused.job.id === cameFrom ? 'enter to return' : 'enter to open'} · space to reply · ctrl+x to delete · ? for shortcuts`

  let lastGroup: Group | null = null
  return (
    <Box flexDirection="column" width={columns}>
      <Box flexDirection="row" gap={2} alignItems="center">
        <Clawd />
        <Box flexDirection="column">
          <Text>
            <Text bold>{getConfiguredUiName(settings)}</Text> <Text dimColor>v{MACRO.VERSION}</Text>
          </Text>
          <Text dimColor>
            New sessions: {renderModelSetting(model)} · {dispatch.effort ?? getDisplayedEffortLevel(model, settings.effortLevel)} effort
          </Text>
          <Text dimColor wrap="truncate-start">
            {cwd ?? process.cwd()}
          </Text>
        </Box>
      </Box>
      <Box paddingLeft={11}>
        <Text dimColor>
          {counts.needs} awaiting input · {counts.working} working · {counts.completed} completed
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {rows !== null && list.length === 0 && (
          <Text dimColor>
            A different way to work with Claude: hand off a bigger task than you would chat through, and Claude
            organizes it in the sections above so you know when it needs you.
          </Text>
        )}
        {list.map(row => {
          const header = row.group !== lastGroup ? GROUP_TITLES[row.group] : null
          lastGroup = row.group
          return (
            <React.Fragment key={row.job.id}>
              {header && (
                <Box marginTop={header === GROUP_TITLES[list[0]!.group] ? 0 : 1}>
                  <Text dimColor>{header}</Text>
                </Box>
              )}
              <AgentRow
                row={row}
                detail={detailFor(row)}
                nameWidth={nameWidth}
                width={columns}
                selected={row === focused}
              />
            </React.Fragment>
          )
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {reply && focused ? (
          <Box borderStyle="round" flexDirection="column" paddingX={1}>
            <Text wrap="truncate-end">{focused.detail}</Text>
            <Text> </Text>
            <InputLine value={reply.text} placeholder="reply" />
          </Box>
        ) : (
          <Box borderStyle="single" borderLeft={false} borderRight={false} borderDimColor>
            <InputLine value={input} placeholder="describe a task for a new session" />
          </Box>
        )}
        {notice && <Text color="warning">{`  ${notice}`}</Text>}
        {helpOpen ? (
          <Box flexDirection="column">
            <Text dimColor>{'  ↑/↓ to select            enter to open         esc to quit'}</Text>
            <Text dimColor>{'  space to reply           ctrl+x to delete      ? to close'}</Text>
          </Box>
        ) : (
          <Text dimColor wrap="truncate-end">
            {'  '}
            {!armed && !reply && !input && <DispatchDefaults dispatch={dispatch} />}
            {hint}
          </Text>
        )}
      </Box>
    </Box>
  )
}

/**
 * `claude agents` in a terminal: lists background sessions by what they
 * need, starts new ones, and opens one in place (Ctrl+Z comes back here).
 */
export async function runAgentView(options: { cwd?: string; dispatch?: Dispatch } = {}): Promise<void> {
  let focus: string | undefined
  let cameFrom: string | undefined
  for (;;) {
    const root = await createRoot(getBaseRenderOptions(false))
    const action = await new Promise<Action>(resolve => {
      root.render(
        <AlternateScreen mouseTracking={false}>
          <AgentView cwd={options.cwd} dispatch={options.dispatch ?? { flags: [] }} initialFocus={focus} cameFrom={cameFrom} onAction={resolve} />
        </AlternateScreen>,
      )
    })
    root.unmount()
    if (action.type === 'quit') return
    let job = (await listJobs()).find(j => j.id === action.id)
    if (!job) continue
    if (job.state !== 'running') {
      try {
        job = await respawnJob(job, 'started by `claude agents`')
      } catch {
        continue
      }
    }
    await attachToJob(job)
    focus = job.id
    cameFrom = job.id
  }
}
