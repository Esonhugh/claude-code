import * as React from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import instances from '../../ink/instances.js'
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
// In agent detail: which pane has focus
type AgentPane = 'left' | 'right'

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

// All icons must NOT match emoji-regex (which gives width 2 via getEmojiWidth)
// ✔ (U+2714), ⏺ (U+23FA), ▪ (U+25AA) all match emoji-regex → width 2 in our stringWidth
// Use only non-emoji chars: ✓ ✗ ⊛ ⬤ ⊘ ⊚
function statusGlyph(s: AgentStatus): { icon: string; color: keyof Theme | undefined } {
  switch (s) {
    case 'done': return { icon: '✓', color: 'success' }
    case 'failed': return { icon: '✗', color: 'error' }
    case 'running': return { icon: '⊛', color: 'suggestion' }
    case 'interrupted': return { icon: '⊘', color: undefined }
    case 'skipped': return { icon: '⊘', color: undefined }
    case 'queued': return { icon: '⊚', color: undefined }
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

// ─── Split Panel ────────────────────────────────────────────
function SplitPanel({ leftNodes, rightNodes, leftTitle, rightTitle, leftWidth, rightWidth, rows, focusPane }: {
  leftNodes: React.ReactNode[]
  rightNodes: React.ReactNode[]
  leftTitle: string; rightTitle: string
  leftWidth: number; rightWidth: number
  rows: number
  focusPane?: AgentPane
}): React.JSX.Element {
  const lFill = '─'.repeat(Math.max(0, leftWidth - stringWidth(leftTitle) - 1))
  const rFill = '─'.repeat(Math.max(0, rightWidth - stringWidth(rightTitle) - 1))
  const totalRows = Math.max(leftNodes.length, rightNodes.length, rows)
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {' ╭ '}{leftTitle}{' '}{lFill}{'┬ '}{rightTitle}{' '}{rFill}{'╮'}
      </Text>
      {Array.from({ length: totalRows }, (_, i) => (
        <Box key={`row-${i}`}>
          <Text dimColor={focusPane !== 'left'}>{' │ '}</Text>
          <Box width={leftWidth}>
            {leftNodes[i] ?? <Text>{' '.repeat(leftWidth)}</Text>}
          </Box>
          <Text dimColor>{'│ '}</Text>
          <Box width={rightWidth}>
            {rightNodes[i] ?? <Text>{' '.repeat(rightWidth)}</Text>}
          </Box>
          <Text dimColor>{'│'}</Text>
        </Box>
      ))}
      <Text dimColor wrap="truncate-end">
        {' ╰'}{'─'.repeat(leftWidth + 1)}{'┴'}{'─'.repeat(rightWidth + 1)}{'╯'}
      </Text>
    </Box>
  )
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
  const [agentPane, setAgentPane] = useState<AgentPane>('left')

  // Force full redraw on state change to prevent character remnants
  // Include phase completion counts so竖线 redraws when labels change width
  const prevStateRef = useRef('')
  const phaseKey = workflow.phases.map(p => `${p.completedAgentIds.length}/${p.agentIds.length}:${p.status}`).join(',')
  useLayoutEffect(() => {
    const key = `${level}-${selectedPhase}-${selectedAgent}-${agentPane}-${detailScroll}-${phaseKey}-${workflow.status}`
    if (prevStateRef.current !== key) {
      instances.get(process.stdout)?.forceRedraw()
      prevStateRef.current = key
    }
  })

  // Show all phases from meta (or those with agents/running)
  const visiblePhases = React.useMemo(() => {
    // If meta has phases, show all of them regardless of state
    if (workflow.meta?.phases && workflow.meta.phases.length > 0) {
      // Map meta phases to matching task phases by title/id
      return workflow.meta.phases.map((mp, idx) => {
        const found = workflow.phases.find(p => p.id === mp.title) ?? workflow.phases[idx]
        return found ?? { id: mp.title, status: 'pending' as const, agentIds: [], completedAgentIds: [], skippedAgentIds: [], failedAgentIds: [], results: [] }
      })
    }
    return workflow.phases.filter(p => p.agentIds.length > 0 || p.status === 'running')
  }, [workflow.phases, workflow.meta])

  const currentPhase = visiblePhases[Math.min(selectedPhase, visiblePhases.length - 1)]
  const agentIds = currentPhase?.agentIds ?? []
  const currentAgentId = agentIds[Math.min(selectedAgent, agentIds.length - 1)]
  const isRunning = workflow.status === 'running'

  // Layout — in agent detail mode, left pane is wider for agent names
  const termRows = process.stdout.rows || 35
  const termCols = process.stdout.columns || 100
  const availableRows = Math.max(8, termRows - 14)
  const PHASE_LEFT_W = 22
  const AGENT_LEFT_W = Math.min(40, Math.max(28, Math.floor(termCols * 0.25)))
  const leftW = level === 'agent' ? AGENT_LEFT_W : PHASE_LEFT_W
  const rightW = Math.max(30, termCols - leftW - 8)

  // Navigation
  function goBack() {
    if (level === 'agent' && agentPane === 'right') { setAgentPane('left'); return }
    if (level === 'agent') { setLevel('agents'); setDetailScroll(0); setAgentPane('left'); return }
    if (level === 'agents') { setLevel('phases'); return }
    close()
  }
  function drillIn() {
    if (level === 'phases' && agentIds.length > 0) { setSelectedAgent(0); setLevel('agents') }
    else if (level === 'agents' && currentAgentId) { setDetailScroll(0); setLevel('agent'); setAgentPane('left') }
    else if (level === 'agent' && agentPane === 'left') { setAgentPane('right') }
  }

  const handleKeyDown = (e: { key: string; ctrl?: boolean; meta?: boolean; preventDefault: () => void }) => {
    if (e.ctrl || e.meta) return
    const k = e.key
    // Agent detail level — left/right switches pane, up/down depends on active pane
    if (level === 'agent') {
      if (k === 'left') { e.preventDefault(); goBack(); return }
      if (k === 'right') { e.preventDefault(); drillIn(); return }
      if (agentPane === 'left' && (k === 'j' || k === 'down')) {
        e.preventDefault(); setSelectedAgent(a => Math.min(agentIds.length - 1, a + 1)); setDetailScroll(0); return
      }
      if (agentPane === 'left' && (k === 'k' || k === 'up')) {
        e.preventDefault(); setSelectedAgent(a => Math.max(0, a - 1)); setDetailScroll(0); return
      }
      if (agentPane === 'right' && (k === 'j' || k === 'down')) {
        e.preventDefault(); setDetailScroll(s => s + 1); return
      }
      if (agentPane === 'right' && (k === 'k' || k === 'up')) {
        e.preventDefault(); setDetailScroll(s => Math.max(0, s - 1)); return
      }
    }
    // Phase / agents list levels
    if (k === 'j' || k === 'down') {
      e.preventDefault()
      if (level === 'phases') setSelectedPhase(p => Math.min(visiblePhases.length - 1, p + 1))
      else setSelectedAgent(a => Math.min(agentIds.length - 1, a + 1))
    } else if (k === 'k' || k === 'up') {
      e.preventDefault()
      if (level === 'phases') setSelectedPhase(p => Math.max(0, p - 1))
      else setSelectedAgent(a => Math.max(0, a - 1))
    } else if (k === 'return' || k === 'right') { e.preventDefault(); drillIn() }
    else if (k === 'left') { e.preventDefault(); goBack() }
    else if (k === 'x' && isRunning && currentAgentId && level !== 'phases' && onSkipAgent) { e.preventDefault(); onSkipAgent(currentAgentId) }
    else if (k === 'x' && isRunning && level === 'phases' && onKill) { e.preventDefault(); onKill() }
    else if (k === 'r' && isRunning && currentAgentId && level !== 'phases' && onRetryAgent) { e.preventDefault(); onRetryAgent(currentAgentId) }
    else if (k === 'p' && isRunning && onPause) { e.preventDefault(); onPause() }
    else if (k === 'p' && workflow.status === 'pending' && onResume) { e.preventDefault(); onResume() }
    else if (k === ' ') { e.preventDefault(); close() }
  }

  // Header
  const total = visibleAgentTotal(workflow)
  const done = completedAgents(workflow)
  const statusWord = workflow.status === 'completed' ? 'done' : workflow.status === 'failed' ? 'failed' : workflow.status === 'pending' ? 'paused' : 'running'
  const statsText = `${done}/${total} ${total === 1 ? 'agent' : 'agents'} · ${formatDuration(elapsedMs(workflow))} · ${statusWord}`

  // Panel titles
  const phaseTitle = currentPhase ? phaseDisplayName(workflow, workflow.phases.indexOf(currentPhase), currentPhase) : ''
  const phasePending = currentPhase && currentPhase.agentIds.length === 0 && currentPhase.status !== 'running'
  const leftTitle = level === 'agent' ? `${phaseTitle} agents` : 'Phases'
  const rightTitle = level === 'agent' && currentAgentId
    ? truncate(currentAgentId, rightW - 2)
    : phasePending ? phaseTitle
    : currentPhase ? `${phaseTitle} · ${agentIds.length} ${agentIds.length === 1 ? 'agent' : 'agents'}` : ''

  // Build left/right React node arrays
  const leftNodes: React.ReactNode[] = []
  const rightNodes: React.ReactNode[] = []

  if (level === 'phases' || level === 'agents') {
    // Left: phase list
    for (let i = 0; i < visiblePhases.length; i++) {
      const phase = visiblePhases[i]!
      const sel = level === 'phases' && i === selectedPhase
      const phaseDone = phase.completedAgentIds.length >= phase.agentIds.length && phase.agentIds.length > 0
      const phaseRunning = !phaseDone && phase.status === 'running'
      const phaseNotStarted = phase.agentIds.length === 0 && phase.status !== 'running'
      const pName = phaseDisplayName(workflow, workflow.phases.indexOf(phase), phase)
      const progress = phase.agentIds.length > 0 ? `${phase.completedAgentIds.length}/${phase.agentIds.length}` : ''
      const icon = phaseDone ? '✓' : phaseRunning ? '⊛' : phaseNotStarted ? String(i + 1) : '⬤'
      const iconColor: keyof Theme | undefined = phaseDone ? 'success' : phaseRunning ? 'suggestion' : undefined
      const label = progress ? `${pName} ${progress}` : pName
      leftNodes.push(
        <Box key={phase.id} width={leftW}>
          <Text wrap="truncate-end">
            <Text color={sel ? 'suggestion' : undefined}>{sel ? '❯ ' : '  '}</Text>
            <Text color={iconColor} dimColor={phaseNotStarted}>{icon}</Text>
            <Text>{' '}</Text>
            <Text color={sel ? 'suggestion' : undefined} dimColor={!sel && !phaseDone && !phaseRunning}>{pad(truncate(label, leftW - 6), leftW - 6)}</Text>
          </Text>
        </Box>,
      )
    }
    // Right: agent list for currentPhase — or "Not running yet" for pending phases
    if (agentIds.length === 0) {
      rightNodes.push(
        <Text key="not-started" dimColor>{'Not running yet'}</Text>,
      )
    }
    const model = workflow.defaultModel ?? 'Claude Opus 4.6'
    for (let i = 0; i < agentIds.length; i++) {
      const id = agentIds[i]!
      const s = agentStatus(workflow, id)
      const g = statusGlyph(s)
      const m = agentMetrics(workflow, id)
      const sel = level === 'agents' && i === selectedAgent
      const metricsStr = m.tokens > 0
        ? `${formatNumber(m.tokens)} tok · ${m.toolCalls} ${m.toolCalls === 1 ? 'tool' : 'tools'}${m.durationMs > 0 ? ' · ' + formatDuration(m.durationMs) : ''}`
        : ''
      // Layout: marker(1) icon(1) space(1) name ... model(center) ... metrics(right)
      const avail = rightW - 3
      const metricsW = stringWidth(metricsStr)
      const modelTrunc = truncate(model, 20)
      const modelStrW = stringWidth(modelTrunc)
      const nameW = Math.max(8, Math.floor(avail * 0.35))
      const nameStr = pad(truncate(id, nameW), nameW)
      const middleZone = avail - nameW - metricsW
      const mPadL = Math.max(1, Math.floor((middleZone - modelStrW) / 2))
      const mPadR = Math.max(0, middleZone - modelStrW - mPadL)
      const line = pad(`${nameStr}${' '.repeat(mPadL)}${modelTrunc}${' '.repeat(mPadR)}${metricsStr}`, avail)
      // Use fixed-width layout: marker(1) + icon(1) + space(1) + line(avail) = rightW
      const fullLine = pad(line, avail)
      rightNodes.push(
        <Box key={id} width={rightW}>
          <Text wrap="truncate-end">
            <Text color={sel ? 'suggestion' : undefined}>{sel ? '❯' : ' '}</Text>
            <Text color={g.color}>{g.icon}</Text>
            <Text dimColor>{' '}{fullLine}</Text>
          </Text>
        </Box>,
      )
    }
  } else if (level === 'agent' && currentAgentId) {
    // Left: agent list (wider) — show full agent names
    for (let i = 0; i < agentIds.length; i++) {
      const id = agentIds[i]!
      const sel = i === selectedAgent
      const as = agentStatus(workflow, id)
      const ag = statusGlyph(as)
      leftNodes.push(
        <Box key={id} width={AGENT_LEFT_W}>
          <Text wrap="truncate-end">
            <Text color={sel ? 'suggestion' : undefined} bold={sel && agentPane === 'left'}>{sel ? '❯ ' : '  '}</Text>
            <Text color={ag.color}>{ag.icon}</Text>
            <Text dimColor={!sel}>{' '}{pad(truncate(id, AGENT_LEFT_W - 5), AGENT_LEFT_W - 5)}</Text>
          </Text>
        </Box>,
      )
    }
    // Right: detail view for selected agent (scrollable)
    const s = agentStatus(workflow, currentAgentId)
    const g = statusGlyph(s)
    const m = agentMetrics(workflow, currentAgentId)
    const outcomeRaw = agentOutcome(workflow, currentAgentId)
    const maxLineW = rightW - 2
    const outcomeLines: string[] = []
    for (const line of outcomeRaw.split('\n')) {
      if (stringWidth(line) <= maxLineW) {
        outcomeLines.push(line)
      } else {
        let remaining = line
        while (stringWidth(remaining) > maxLineW) {
          outcomeLines.push(remaining.slice(0, maxLineW))
          remaining = remaining.slice(maxLineW)
        }
        if (remaining) outcomeLines.push(remaining)
      }
    }
    const liveAgent = workflow.liveAgents?.[currentAgentId]
    const activities = liveAgent?.recentActivities ?? []
    const activityLines = activities.length > 0
      ? activities.map(a => truncate(a, maxLineW))
      : [liveAgent?.activity ?? (m.toolCalls > 0 ? `${m.toolCalls} tool ${m.toolCalls === 1 ? 'call' : 'calls'} completed` : 'No tool calls.')]
    const promptText = agentPrompt(workflow, currentAgentId)
    const promptLines = promptText.split('\n')
    const promptPreview = promptLines.length > 2
      ? [truncate(promptLines[0]!, maxLineW), `… ${promptLines.length - 1} more lines`]
      : promptLines.map(l => truncate(l, maxLineW))

    const detailNodes: React.ReactNode[] = [
      <Box key="status">
        <Text color={g.color}>{g.icon}</Text>
        <Text bold>{' '}{STATUS_LABELS[s]}</Text>
        <Text dimColor>{' · '}{workflow.defaultModel ?? 'Claude Opus 4.6'}</Text>
      </Box>,
      <Text key="metrics" dimColor>
        {formatNumber(m.tokens)}{' tok · '}{m.toolCalls}{' tool '}{m.toolCalls === 1 ? 'call' : 'calls'}{m.durationMs > 0 ? ` · ${formatDuration(m.durationMs)}` : ''}
      </Text>,
      <Text key="s1">{' '}</Text>,
      <Text key="ph" bold dimColor>{'Prompt'}{' · '}{promptLines.length}{' lines'}</Text>,
      ...promptPreview.map((l, i) => <Text key={`p${i}`} dimColor>{'  '}{l}</Text>),
      <Text key="s2">{' '}</Text>,
      <Text key="ah" bold dimColor>{'Activity'}</Text>,
      ...activityLines.map((l, i) => <Text key={`a${i}`} dimColor>{'  '}{l}</Text>),
      <Text key="s3">{' '}</Text>,
      <Text key="oh" bold dimColor>{'Outcome'}</Text>,
      ...outcomeLines.map((l, i) => <Text key={`o${i}`}>{'  '}{l}</Text>),
    ]
    // Clamp scroll
    const maxScroll = Math.max(0, detailNodes.length - availableRows)
    const scroll = Math.min(detailScroll, maxScroll)
    if (scroll !== detailScroll) setDetailScroll(scroll)
    const visible = detailNodes.slice(scroll, scroll + availableRows)
    for (const node of visible) rightNodes.push(node)
  }

  // Hints
  const hints: string[] = []
  if (level === 'agent') {
    if (agentPane === 'left') hints.push('↑↓ switch agent · → detail')
    else hints.push('↑↓ scroll outcome · ← agents')
    hints.push('esc back')
  } else {
    hints.push('↑↓ select · ⏎/→ expand · esc back')
  }
  if (isRunning && currentAgentId && level !== 'phases') hints.push('x stop')
  if (isRunning && level === 'phases' && onKill) hints.push('x stop workflow')

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog title={null} hideBorder hideInputGuide onCancel={goBack} color="text">
        <Box flexDirection="column" overflowY="hidden">
          <Text dimColor wrap="truncate-end">{'─'.repeat(termCols - 4)}</Text>
          <Text bold color="suggestion" wrap="truncate-end">{' '}{workflowTitle(workflow)}</Text>
          <Box>
            <Text dimColor wrap="truncate-end">{' '}{workflowDescription(workflow)}{'  '}{statsText}</Text>
          </Box>
          <Text>{' '}</Text>
          <SplitPanel
            leftNodes={leftNodes} rightNodes={rightNodes}
            leftTitle={leftTitle} rightTitle={rightTitle}
            leftWidth={leftW} rightWidth={rightW}
            rows={availableRows}
            focusPane={level === 'agent' ? agentPane : undefined}
          />
          <Text dimColor italic wrap="truncate-end">{' '}{hints.join(' · ')}</Text>
        </Box>
      </Dialog>
    </Box>
  )
}
