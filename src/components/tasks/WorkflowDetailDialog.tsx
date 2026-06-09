import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from '../../ink.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { WorkflowAgentResult } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { Theme } from '../../utils/theme.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import { stringWidth } from '../../ink/stringWidth.js'

type Props = {
  workflow?: LocalWorkflowTaskState
  onBack?: () => void
  onKill?: () => void
  onSkipAgent?: (agentId: string) => void
  onRetryAgent?: (agentId: string) => void
  onPause?: () => void
  onResume?: () => void
}

type Level = 'phases' | 'agents' | 'agent'
type AgentStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'interrupted'

// ─── Helpers ───────────────────────────────────────────────
function completedAgents(task: LocalWorkflowTaskState): number {
  return task.phases.reduce((sum, phase) => sum + phase.completedAgentIds.length, 0)
}

function elapsedMs(task: LocalWorkflowTaskState): number {
  return Math.max(0, ((task.endTime ?? Date.now()) - task.startTime - (task.totalPausedMs ?? 0)))
}

function workflowTitle(task: LocalWorkflowTaskState): string {
  return task.workflowName ?? task.description.replace(/^Workflow:\s*/i, '')
}

function workflowDescription(task: LocalWorkflowTaskState): string {
  return task.meta?.description ?? task.summary ?? task.description.replace(/^Workflow:\s*/i, '')
}

function visibleAgentTotal(task: LocalWorkflowTaskState): number {
  const started = task.phases.reduce((sum, phase) => sum + phase.agentIds.length, 0)
  if ((task.status === 'running' || task.status === 'pending') && started > 0) return started
  return task.agentCount ?? started
}

function phaseDisplayName(task: LocalWorkflowTaskState, phaseIndex: number, phase: { id: string }): string {
  return task.meta?.phases?.[phaseIndex]?.title ?? phase.id
}

// ANSI 256-color helpers matching official Claude Code workflow UI
const W = '\x1b[38;5;231m' // bright white for borders
const R = '\x1b[39m'        // reset fg
const C = {
  green: (s: string) => `\x1b[38;5;114m${s}\x1b[39m`,
  sel: (s: string) => `\x1b[38;5;153m${s}\x1b[39m`,     // light blue (selected)
  dim: (s: string) => `\x1b[38;5;246m${s}\x1b[39m`,     // dim gray
  dark: (s: string) => `\x1b[38;5;239m${s}\x1b[39m`,    // dark gray (pending numbers, running ⏺)
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  boldDim: (s: string) => `\x1b[1m\x1b[38;5;246m${s}\x1b[0m`,
  white: (s: string) => `${W}${s}${R}`,                  // bright white (borders)
  reset: '\x1b[0m',
}

function colorIcon(status: AgentStatus, icon: string): string {
  switch (status) {
    case 'done': return C.green(icon)
    case 'failed': return C.red(icon)
    case 'running': return C.blue(icon)
    default: return icon
  }
}

function agentPhase(task: LocalWorkflowTaskState, agentId: string) {
  return task.phases.find(p => p.agentIds.includes(agentId))
}

function workflowAgentResult(task: LocalWorkflowTaskState, agentId: string): WorkflowAgentResult | undefined {
  const direct = task.results.find(r => r.agentId === agentId) ??
    task.phases.flatMap(p => p.results).find(r => r.agentId === agentId)
  if (direct) return direct
  const phase = agentPhase(task, agentId)
  if (!phase) return undefined
  const idx = phase.agentIds.indexOf(agentId)
  if (idx < 0) return undefined
  return phase.results.find(r => r.index === idx) ??
    task.results.find(r => r.phaseId === phase.id && r.index === idx)
}

function agentMetrics(task: LocalWorkflowTaskState, agentId: string) {
  const result = workflowAgentResult(task, agentId)
  const live = task.liveAgents?.[agentId]
  return {
    tokens: live?.tokenCount ?? result?.tokenCount ?? 0,
    toolCalls: live?.toolUseCount ?? result?.toolUseCount ?? 0,
    durationMs: result?.durationMs ?? 0,
  }
}

function agentStatus(task: LocalWorkflowTaskState, agentId: string): AgentStatus {
  if (task.status === 'pending') return 'interrupted'
  const phase = agentPhase(task, agentId)
  if (phase?.completedAgentIds.includes(agentId)) {
    const r = workflowAgentResult(task, agentId)
    if (r?.status === 'failed') return 'failed'
    if (r?.status === 'skipped') return 'skipped'
    return 'done'
  }
  // Also check by index: agent may have been registered with one ID but completed with another
  if (phase) {
    const idx = phase.agentIds.indexOf(agentId)
    if (idx >= 0) {
      const resultAtIndex = phase.results.find(r => r.index === idx)
      if (resultAtIndex) {
        if (resultAtIndex.status === 'failed') return 'failed'
        if (resultAtIndex.status === 'skipped') return 'skipped'
        return 'done'
      }
    }
  }
  if (task.liveAgents?.[agentId]) return 'running'
  if (task.status === 'completed' || task.status === 'failed') {
    const r = workflowAgentResult(task, agentId)
    if (r) return r.status === 'failed' ? 'failed' : r.status === 'skipped' ? 'skipped' : 'done'
    return task.status === 'completed' ? 'done' : 'interrupted'
  }
  return 'queued'
}

function statusGlyph(s: AgentStatus): { icon: string; color: keyof Theme | undefined } {
  switch (s) {
    case 'done': return { icon: '✓', color: 'success' }
    case 'failed': return { icon: '✗', color: 'error' }
    case 'running': return { icon: '●', color: 'suggestion' }
    case 'interrupted': return { icon: '◌', color: undefined }
    case 'skipped': return { icon: '⊘', color: undefined }
    case 'queued': return { icon: '○', color: undefined }
  }
}

const STATUS_LABELS: Record<AgentStatus, string> = {
  queued: 'Queued', running: 'Running', done: 'Completed',
  failed: 'Failed', skipped: 'Skipped', interrupted: 'Stopped',
}

function agentPrompt(task: LocalWorkflowTaskState, agentId: string): string {
  const pi = task.phases.findIndex(p => p.agentIds.includes(agentId))
  const result = workflowAgentResult(task, agentId)
  return task.liveAgents?.[agentId]?.prompt ?? result?.prompt ?? task.meta?.phases?.[pi]?.detail ?? agentId
}

function agentOutcome(task: LocalWorkflowTaskState, agentId: string): string {
  const s = agentStatus(task, agentId)
  if (s === 'queued') return 'Waiting for an agent slot.'
  if (s === 'running') return 'Still running…'
  if (s === 'interrupted') return 'The workflow stopped before this agent finished.'
  if (s === 'skipped') return 'Skipped by user.'
  if (s === 'failed') return workflowAgentResult(task, agentId)?.error ?? 'failed'
  return workflowAgentResult(task, agentId)?.output ?? '(empty)'
}

function truncate(str: string, maxLen: number): string {
  if (stringWidth(str) <= maxLen) return str
  let w = 0
  let i = 0
  for (; i < str.length; i++) {
    const cw = stringWidth(str[i]!)
    if (w + cw > maxLen - 1) break
    w += cw
  }
  return str.slice(0, i) + '…'
}

function pad(str: string, width: number): string {
  const w = stringWidth(str)
  return w >= width ? truncate(str, width) : str + ' '.repeat(Math.max(0, width - w))
}

// Strip ANSI escape sequences for width calculation
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

// ─── Split Panel (box-drawing chars like official) ──────────
// Render panel as separate <Text> per line to avoid Ink ANSI diff corruption
function SplitPanel({ rows, leftTitle, rightTitle, leftWidth, rightWidth }: {
  rows: Array<{ left: string; right: string }>
  leftTitle: string; rightTitle: string; leftWidth: number; rightWidth: number
  panelKey?: string
}): React.JSX.Element {
  const lTitleWidth = stringWidth(leftTitle)
  const rTitleWidth = stringWidth(rightTitle)
  const lFill = '─'.repeat(Math.max(0, leftWidth - lTitleWidth - 1))
  const rFill = '─'.repeat(Math.max(0, rightWidth - rTitleWidth - 1))
  const top = C.white(` ╭ ${leftTitle} ${lFill}┬ ${rightTitle} ${rFill}╮`)
  const bot = C.white(` ╰${'─'.repeat(leftWidth + 1)}┴${'─'.repeat(rightWidth + 1)}╯`)
  const rowLines = rows.map(row => {
    const l = padVisible(row.left, leftWidth)
    const r = padVisible(row.right, rightWidth)
    return `\x1b[2K${W} │${R} ${l}\x1b[0m${W}│${R} ${r}\x1b[0m${W}│${R}`
  })
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">{'\x1b[2K'}{top}</Text>
      {rowLines.map((line, i) => <Text key={i} wrap="truncate-end">{line}</Text>)}
      <Text wrap="truncate-end">{'\x1b[2K'}{bot}</Text>
    </Box>
  )
}

function SplitPanelRow(_props: { left: string; right: string; leftWidth: number; rightWidth: number; rowKey: string }): React.JSX.Element {
  return <Text />
}

function padVisible(str: string, width: number): string {
  const vis = stringWidth(str)
  if (vis >= width) {
    // Truncate to exact width to prevent overflow
    return truncate(str, width)
  }
  return str + ' '.repeat(Math.max(0, width - vis))
}

// ─── Main Component ─────────────────────────────────────────
export function WorkflowDetailDialog({
  workflow,
  onBack,
  onKill,
  onSkipAgent,
  onRetryAgent,
  onPause,
  onResume,
}: Props): React.JSX.Element {
  useRegisterOverlay('workflow-detail-dialog')
  const close = onBack ?? (() => undefined)

  if (!workflow) {
    return (
      <Dialog title="Dynamic workflow" onCancel={close} color="text">
        <Text>Workflow details unavailable.</Text>
      </Dialog>
    )
  }

  const [level, setLevel] = useState<Level>('phases')
  const [selectedPhase, setSelectedPhase] = useState(0)
  const [selectedAgent, setSelectedAgent] = useState(0)
  const [detailScroll, setDetailScroll] = useState(0)

  // Show all phases (including pending ones) like official
  const visiblePhases = React.useMemo(
    () => workflow.phases.filter(p => p.agentIds.length > 0 || p.status === 'running' || p.status === 'pending'),
    [workflow.phases],
  )

  const currentPhase = visiblePhases[Math.min(selectedPhase, visiblePhases.length - 1)]
  const agentIds = currentPhase?.agentIds ?? []
  const currentAgentId = agentIds[Math.min(selectedAgent, agentIds.length - 1)]
  const isRunning = workflow.status === 'running'

  // Layout - use terminal dimensions to fit panel
  const termRows = process.stdout.rows || 35
  const termCols = process.stdout.columns || 100
  const availableRows = Math.max(8, termRows - 14) // reserve for separator/title/desc/blank + panel borders + hints + prompt
  const LEFT_WIDTH = 18
  const RIGHT_WIDTH = Math.max(40, termCols - LEFT_WIDTH - 8)

  // Navigation
  function goBack() {
    if (level === 'agent') { setLevel('agents'); setDetailScroll(0); return }
    if (level === 'agents') { setLevel('phases'); return }
    close()
  }
  function drillIn() {
    if (level === 'phases' && agentIds.length > 0) { setSelectedAgent(0); setLevel('agents') }
    else if (level === 'agents' && currentAgentId) { setDetailScroll(0); setLevel('agent') }
  }
  function moveUp() {
    if (level === 'phases') setSelectedPhase(p => Math.max(0, p - 1))
    else { setSelectedAgent(a => Math.max(0, a - 1)); setDetailScroll(0) }
  }
  function moveDown() {
    if (level === 'phases') setSelectedPhase(p => Math.min(visiblePhases.length - 1, p + 1))
    else { setSelectedAgent(a => Math.min(agentIds.length - 1, a + 1)); setDetailScroll(0) }
  }
  function scrollUp() { setDetailScroll(s => Math.max(0, s - 1)) }
  function scrollDown() { setDetailScroll(s => s + 1) } // clamped at render time

  const handleKeyDown = (e: { key: string; ctrl?: boolean; meta?: boolean; preventDefault: () => void }) => {
    if (e.ctrl || e.meta) return
    if (level === 'agent' && (e.key === 'j' || e.key === 'down')) { e.preventDefault(); scrollDown() }
    else if (level === 'agent' && (e.key === 'k' || e.key === 'up')) { e.preventDefault(); scrollUp() }
    else if (e.key === 'j' || e.key === 'down') { e.preventDefault(); moveDown() }
    else if (e.key === 'k' || e.key === 'up') { e.preventDefault(); moveUp() }
    else if (e.key === 'return' || e.key === 'right') { e.preventDefault(); drillIn() }
    else if (e.key === 'left') { e.preventDefault(); goBack() }
    else if (e.key === 'x' && isRunning && currentAgentId && level !== 'phases' && onSkipAgent) { e.preventDefault(); onSkipAgent(currentAgentId) }
    else if (e.key === 'x' && isRunning && level === 'phases' && onKill) { e.preventDefault(); onKill() }
    else if (e.key === 'r' && isRunning && currentAgentId && level !== 'phases' && onRetryAgent) { e.preventDefault(); onRetryAgent(currentAgentId) }
    else if (e.key === 'p' && isRunning && onPause) { e.preventDefault(); onPause() }
    else if (e.key === 'p' && workflow.status === 'pending' && onResume) { e.preventDefault(); onResume() }
    else if (e.key === ' ') { e.preventDefault(); close() }
  }

  // Header
  const total = visibleAgentTotal(workflow)
  const done = completedAgents(workflow)
  const statusWord = workflow.status === 'completed' ? 'done' : workflow.status === 'failed' ? 'failed' : workflow.status === 'pending' ? 'paused' : 'running'
  const statsText = `${done}/${total} ${total === 1 ? 'agent' : 'agents'} · ${formatDuration(elapsedMs(workflow))} · ${statusWord}`

  // Panel titles
  const phaseTitle = currentPhase ? phaseDisplayName(workflow, workflow.phases.indexOf(currentPhase), currentPhase) : ''
  const leftTitle = level === 'agent' ? `${phaseTitle} · ${agentIds.length} ${agentIds.length === 1 ? 'agent' : 'agents'}` : 'Phases'
  const rightTitle = level === 'agent' && currentAgentId
    ? truncate(currentAgentId, RIGHT_WIDTH - 2)
    : currentPhase ? `${phaseTitle} · ${agentIds.length} ${agentIds.length === 1 ? 'agent' : 'agents'}` : ''

  // Build rows
  const rows: Array<{ left: string; right: string }> = []

  if (level === 'phases' || level === 'agents') {
    // Left column: visible phase list (filtered)
    const maxRows = Math.max(visiblePhases.length, agentIds.length, 1)
    for (let i = 0; i < maxRows; i++) {
      let left = ''
      if (i < visiblePhases.length) {
        const phase = visiblePhases[i]!
        const sel = level === 'phases' && i === selectedPhase
        const phaseDone = phase.completedAgentIds.length >= phase.agentIds.length && phase.agentIds.length > 0
        const phaseRunning = !phaseDone && phase.status === 'running'
        const phaseIcon = phaseDone ? C.green('✔') : phaseRunning ? C.dark('●') : C.dark(String(i + 1))
        const marker = sel ? C.sel('❯') + ' ' : '  '
        const pName = phaseDisplayName(workflow, workflow.phases.indexOf(phase), phase)
        const progress = phase.agentIds.length > 0 ? C.dark(`${phase.completedAgentIds.length}/${phase.agentIds.length}`) : ''
        const nameStr = sel ? C.sel(truncate(pName, LEFT_WIDTH - 8)) : (phaseDone ? truncate(pName, LEFT_WIDTH - 8) : C.dim(truncate(pName, LEFT_WIDTH - 8)))
        left = `${marker}${phaseIcon} ${nameStr}${progress ? ' ' + progress : ''}`
      }

      let right = ''
      if (i < agentIds.length) {
        const id = agentIds[i]!
        const s = agentStatus(workflow, id)
        const g = statusGlyph(s)
        const m = agentMetrics(workflow, id)
        const sel = level === 'agents' && i === selectedAgent
        const marker = sel ? C.sel('❯') : ' '
        const model = workflow.defaultModel ?? 'Claude Opus 4.6'
        const NAME_COL = Math.min(28, Math.floor((RIGHT_WIDTH - 6) * 0.4))
        const MODEL_COL = Math.min(18, Math.floor((RIGHT_WIDTH - 6) * 0.25))
        const nameStr = pad(truncate(id, NAME_COL), NAME_COL)
        const modelStr = pad(truncate(model, MODEL_COL), MODEL_COL)
        const metricsStr = m.tokens > 0
          ? `${formatNumber(m.tokens)} tok · ${m.toolCalls} ${m.toolCalls === 1 ? 'tool' : 'tools'}${m.durationMs > 0 ? ' · ' + formatDuration(m.durationMs) : ''}`
          : ''
        const colorIcon = s === 'done' ? C.green(g.icon) : s === 'running' ? C.dark(g.icon) : C.dark(g.icon)
        const usedWidth = 3 + NAME_COL + 2 + MODEL_COL
        const gap = Math.max(2, RIGHT_WIDTH - usedWidth - stringWidth(metricsStr))
        right = `${marker}${colorIcon} ${C.dim(nameStr)}  ${C.dim(modelStr)}${' '.repeat(gap)}${C.dim(metricsStr)}\x1b[0m`
      }
      rows.push({ left, right })
    }
  } else if (level === 'agent' && currentAgentId) {
    // Left: agent list, Right: agent detail with scrollable outcome
    const s = agentStatus(workflow, currentAgentId)
    const g = statusGlyph(s)
    const m = agentMetrics(workflow, currentAgentId)

    // Build outcome lines, wrapping to fit right panel
    const outcomeRaw = agentOutcome(workflow, currentAgentId)
    const outcomeMaxWidth = RIGHT_WIDTH - 4
    const outcomeLines: string[] = []
    for (const line of outcomeRaw.split('\n')) {
      if (stringWidth(stripAnsi(line)) <= outcomeMaxWidth) {
        outcomeLines.push(`  ${line}`)
      } else {
        // Simple word-wrap
        let remaining = line
        while (stringWidth(stripAnsi(remaining)) > outcomeMaxWidth) {
          outcomeLines.push(`  ${remaining.slice(0, outcomeMaxWidth)}`)
          remaining = remaining.slice(outcomeMaxWidth)
        }
        if (remaining) outcomeLines.push(`  ${remaining}`)
      }
    }

    // Activity lines from recent activities or result tool count
    const liveAgent = workflow.liveAgents?.[currentAgentId]
    const activities = liveAgent?.recentActivities ?? []
    const activityLines = activities.length > 0
      ? activities.map(a => `  ${truncate(a, RIGHT_WIDTH - 4)}`)
      : [`  ${liveAgent?.activity ?? (m.toolCalls > 0 ? `${m.toolCalls} tool ${m.toolCalls === 1 ? 'call' : 'calls'} completed` : 'No tool calls.')}`]

    // Prompt (collapsible)
    const promptText = agentPrompt(workflow, currentAgentId)
    const promptLines = promptText.split('\n')
    const promptPreview = promptLines.length > 2
      ? [`  ${truncate(promptLines[0]!, RIGHT_WIDTH - 4)}`, `  … ${promptLines.length - 1} more lines`]
      : promptLines.map(l => `  ${truncate(l, RIGHT_WIDTH - 4)}`)

    const detailLines = [
      `${s === 'done' ? C.green(g.icon) : C.dark(g.icon)} ${s === 'done' ? C.bold(C.green('Completed')) : C.bold(STATUS_LABELS[s])}${C.dim(' · ' + (workflow.defaultModel ?? 'Claude Opus 4.6'))}`,
      C.dim(`${formatNumber(m.tokens)} tok · ${m.toolCalls} tool ${m.toolCalls === 1 ? 'call' : 'calls'}${m.durationMs > 0 ? ` · ${formatDuration(m.durationMs)}` : ''}`),
      '',
      `${C.boldDim('Prompt')}${C.dim(` · ${promptLines.length} lines`)}`,
      ...promptPreview.map(l => C.dim(l)),
      '',
      C.boldDim('Activity'),
      ...activityLines.map(l => C.dim(l)),
      '',
      C.boldDim('Outcome'),
      ...outcomeLines,
    ]
    // Apply scroll offset to detail lines (right panel scrolls, left stays)
    const maxScroll = Math.max(0, detailLines.length - availableRows)
    const scroll = Math.min(detailScroll, maxScroll)
    if (scroll !== detailScroll) setDetailScroll(scroll)
    const visibleDetail = detailLines.slice(scroll, scroll + availableRows)

    const maxRows = Math.max(agentIds.length, visibleDetail.length)
    for (let i = 0; i < maxRows; i++) {
      let left = ''
      if (i < agentIds.length) {
        const id = agentIds[i]!
        const sel = i === selectedAgent
        const as = agentStatus(workflow, id)
        const ag = statusGlyph(as)
        const colorIcon = as === 'done' ? C.green(ag.icon) : C.dark(ag.icon)
        left = `${sel ? C.sel('❯') + ' ' : '  '}${colorIcon} ${C.dim(truncate(id, LEFT_WIDTH - 5))}`
      }
      rows.push({ left: left, right: visibleDetail[i] ?? '' })
    }
  }

  // Fill to fit available terminal height
  while (rows.length < availableRows) {
    rows.push({ left: '', right: '' })
  }
  // Cap at available rows
  if (rows.length > availableRows) {
    rows.length = availableRows
  }

  // Hints
  const hints: string[] = []
  if (level === 'agent') hints.push('↑↓/j/k scroll · ←/esc back')
  else hints.push('↑↓ select')
  hints.push('⏎ expand')
  if (isRunning && currentAgentId && level !== 'phases') hints.push('x stop')
  if (isRunning && level === 'phases' && onKill) hints.push('x stop workflow')
  if (isRunning && onPause) hints.push('p pause')
  else if (workflow.status === 'pending' && onResume) hints.push('p resume')
  hints.push('esc back')

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog title={null} hideBorder hideInputGuide onCancel={goBack} color="text">
        <Box flexDirection="column" overflowY="hidden">
          <Text wrap="truncate-end">{'\x1b[2K'}{C.white('─'.repeat(termCols - 4))}</Text>
          <Text wrap="truncate-end">{'\x1b[2K'}{C.sel(C.bold(` ${workflowTitle(workflow)}`))}</Text>
          <Text wrap="truncate-end">{'\x1b[2K'}{C.dim(` ${workflowDescription(workflow)}`)}{'  '}{C.dim(statsText)}</Text>
          <Text>{'\x1b[2K'}</Text>
          <SplitPanel rows={rows} leftTitle={leftTitle} rightTitle={rightTitle} leftWidth={LEFT_WIDTH} rightWidth={RIGHT_WIDTH} />
          <Text dimColor italic wrap="truncate-end">{'\x1b[2K'}{' '}{hints.join(' · ')}</Text>
        </Box>
      </Dialog>
    </Box>
  )
}
