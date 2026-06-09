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

// ─── Themed inline components ───────────────────────────────
function PhaseRow({ selected, done, running, name, progress, leftWidth }: {
  selected: boolean; done: boolean; running: boolean; name: string; progress: string; index: number; leftWidth: number
}): React.JSX.Element {
  const icon = done ? '✔' : running ? '●' : '○'
  const iconColor: keyof Theme | undefined = done ? 'success' : undefined
  const label = progress ? `${name} ${progress}` : name
  return (
    <Text wrap="truncate-end">
      <Text color={selected ? 'suggestion' : undefined}>{selected ? '❯ ' : '  '}</Text>
      <Text color={iconColor} dimColor={!done && !running}>{icon}</Text>
      <Text>{' '}</Text>
      <Text color={selected ? 'suggestion' : undefined} dimColor={!selected && !done}>
        {pad(label, leftWidth - 5)}
      </Text>
    </Text>
  )
}

function AgentRow({ selected, status, id, model, metrics, nameWidth, modelWidth, totalWidth }: {
  selected: boolean; status: AgentStatus; id: string; model: string
  metrics: string; nameWidth: number; modelWidth: number; totalWidth: number
}): React.JSX.Element {
  const g = statusGlyph(status)
  // Build a fixed-width padded string to prevent Ink diff artifacts
  const marker = selected ? '❯' : ' '
  const nameStr = pad(truncate(id, nameWidth), nameWidth)
  const modelStr = pad(truncate(model, modelWidth), modelWidth)
  const content = `${marker}${g.icon} ${nameStr}  ${modelStr}  ${metrics}`
  return (
    <Text wrap="truncate-end">
      <Text color={selected ? 'suggestion' : undefined}>{marker}</Text>
      <Text color={g.color}>{g.icon}</Text>
      <Text dimColor>{' '}{pad(`${nameStr}  ${modelStr}  ${metrics}`, totalWidth - 3)}</Text>
    </Text>
  )
}

// ─── Split Panel using React components ──────────────────────
function SplitPanel({ leftNodes, rightNodes, leftTitle, rightTitle, leftWidth, rightWidth, availableRows: maxRows }: {
  leftNodes: React.ReactNode[]
  rightNodes: React.ReactNode[]
  leftTitle: string; rightTitle: string
  leftWidth: number; rightWidth: number
  availableRows: number
}): React.JSX.Element {
  const lFill = '─'.repeat(Math.max(0, leftWidth - stringWidth(leftTitle) - 1))
  const rFill = '─'.repeat(Math.max(0, rightWidth - stringWidth(rightTitle) - 1))
  const totalRows = Math.max(leftNodes.length, rightNodes.length, maxRows)
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {' ╭ '}{leftTitle}{' '}{lFill}{'┬ '}{rightTitle}{' '}{rFill}{'╮'}
      </Text>
      {Array.from({ length: totalRows }, (_, i) => (
        <Box key={`${leftTitle}-${rightTitle}-${i}`} width={leftWidth + rightWidth + 7}>
          <Text dimColor>{' │ '}</Text>
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

  // Force full redraw when phase selection or level changes to prevent character remnants
  const prevPhaseRef = useRef(selectedPhase)
  const prevLevelRef = useRef(level)
  const prevAgentRef = useRef(selectedAgent)
  useLayoutEffect(() => {
    if (prevPhaseRef.current !== selectedPhase || prevLevelRef.current !== level || prevAgentRef.current !== selectedAgent) {
      const ink = instances.get(process.stdout)
      ink?.forceRedraw()
      prevPhaseRef.current = selectedPhase
      prevLevelRef.current = level
      prevAgentRef.current = selectedAgent
    }
  })

  // Show only phases that have agents registered (skip empty placeholder phases)
  const visiblePhases = React.useMemo(
    () => workflow.phases.filter(p => p.agentIds.length > 0),
    [workflow.phases],
  )

  const currentPhase = visiblePhases[Math.min(selectedPhase, visiblePhases.length - 1)]
  const agentIds = currentPhase?.agentIds ?? []
  const currentAgentId = agentIds[Math.min(selectedAgent, agentIds.length - 1)]
  const isRunning = workflow.status === 'running'

  // Layout
  const termRows = process.stdout.rows || 35
  const termCols = process.stdout.columns || 100
  const availableRows = Math.max(8, termRows - 14)
  const LEFT_WIDTH = 22
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
  function scrollDown() { setDetailScroll(s => s + 1) }

  const handleKeyDown = (e: { key: string; ctrl?: boolean; meta?: boolean; preventDefault: () => void }) => {
    if (e.ctrl || e.meta) return
    if (level === 'agent' && (e.key === 'j' || e.key === 'down')) { e.preventDefault(); moveDown() }
    else if (level === 'agent' && (e.key === 'k' || e.key === 'up')) { e.preventDefault(); moveUp() }
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
  const leftTitle = level === 'agent' ? `${phaseTitle}` : 'Phases'
  const rightTitle = level === 'agent' && currentAgentId
    ? truncate(currentAgentId, RIGHT_WIDTH - 2)
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
      const pName = phaseDisplayName(workflow, workflow.phases.indexOf(phase), phase)
      const progress = phase.agentIds.length > 0 ? `${phase.completedAgentIds.length}/${phase.agentIds.length}` : ''
      leftNodes.push(
        <PhaseRow key={phase.id} selected={sel} done={phaseDone} running={phaseRunning}
          name={truncate(pName, LEFT_WIDTH - 8)} progress={progress} index={i} leftWidth={LEFT_WIDTH} />,
      )
    }
    // Right: agent list for currentPhase
    const model = workflow.defaultModel ?? 'Claude Opus 4.6'
    const NAME_COL = Math.min(28, Math.floor((RIGHT_WIDTH - 6) * 0.4))
    const MODEL_COL = Math.min(18, Math.floor((RIGHT_WIDTH - 6) * 0.25))
    for (let i = 0; i < agentIds.length; i++) {
      const id = agentIds[i]!
      const s = agentStatus(workflow, id)
      const m = agentMetrics(workflow, id)
      const sel = level === 'agents' && i === selectedAgent
      const metricsStr = m.tokens > 0
        ? `${formatNumber(m.tokens)} tok · ${m.toolCalls} ${m.toolCalls === 1 ? 'tool' : 'tools'}${m.durationMs > 0 ? ' · ' + formatDuration(m.durationMs) : ''}`
        : ''
      rightNodes.push(
        <AgentRow key={id} selected={sel} status={s} id={id} model={model}
          metrics={metricsStr} nameWidth={NAME_COL} modelWidth={MODEL_COL} totalWidth={RIGHT_WIDTH} />,
      )
    }
  } else if (level === 'agent' && currentAgentId) {
    // Left: agent list in the current phase
    for (let i = 0; i < agentIds.length; i++) {
      const id = agentIds[i]!
      const sel = i === selectedAgent
      const as = agentStatus(workflow, id)
      const ag = statusGlyph(as)
      leftNodes.push(
        <Box key={id}>
          <Text color={sel ? 'suggestion' : undefined}>{sel ? '❯ ' : '  '}</Text>
          <Text color={ag.color}>{ag.icon}</Text>
          <Text dimColor>{' '}{truncate(id, LEFT_WIDTH - 5)}</Text>
        </Box>,
      )
    }
    // Right: detail view for selected agent
    const s = agentStatus(workflow, currentAgentId)
    const g = statusGlyph(s)
    const m = agentMetrics(workflow, currentAgentId)
    const outcomeRaw = agentOutcome(workflow, currentAgentId)
    const outcomeMaxWidth = RIGHT_WIDTH - 4
    const outcomeLines: string[] = []
    for (const line of outcomeRaw.split('\n')) {
      if (stringWidth(line) <= outcomeMaxWidth) {
        outcomeLines.push(line)
      } else {
        let remaining = line
        while (stringWidth(remaining) > outcomeMaxWidth) {
          outcomeLines.push(remaining.slice(0, outcomeMaxWidth))
          remaining = remaining.slice(outcomeMaxWidth)
        }
        if (remaining) outcomeLines.push(remaining)
      }
    }
    const liveAgent = workflow.liveAgents?.[currentAgentId]
    const activities = liveAgent?.recentActivities ?? []
    const activityLines = activities.length > 0
      ? activities.map(a => truncate(a, RIGHT_WIDTH - 4))
      : [liveAgent?.activity ?? (m.toolCalls > 0 ? `${m.toolCalls} tool ${m.toolCalls === 1 ? 'call' : 'calls'} completed` : 'No tool calls.')]
    const promptText = agentPrompt(workflow, currentAgentId)
    const promptLines = promptText.split('\n')
    const promptPreview = promptLines.length > 2
      ? [truncate(promptLines[0]!, RIGHT_WIDTH - 4), `… ${promptLines.length - 1} more lines`]
      : promptLines.map(l => truncate(l, RIGHT_WIDTH - 4))

    // Build detail nodes
    const detailNodes: React.ReactNode[] = [
      <Box key="status">
        <Text color={g.color}>{g.icon}</Text>
        <Text bold>{' '}{STATUS_LABELS[s]}</Text>
        <Text dimColor>{' · '}{workflow.defaultModel ?? 'Claude Opus 4.6'}</Text>
      </Box>,
      <Text key="metrics" dimColor>
        {formatNumber(m.tokens)} tok · {m.toolCalls} tool {m.toolCalls === 1 ? 'call' : 'calls'}{m.durationMs > 0 ? ` · ${formatDuration(m.durationMs)}` : ''}
      </Text>,
      <Text key="spacer1"> </Text>,
      <Text key="prompt-header" bold dimColor>{'Prompt'}<Text dimColor>{' · '}{promptLines.length}{' lines'}</Text></Text>,
      ...promptPreview.map((l, i) => <Text key={`pp-${i}`} dimColor>{'  '}{l}</Text>),
      <Text key="spacer2"> </Text>,
      <Text key="activity-header" bold dimColor>Activity</Text>,
      ...activityLines.map((l, i) => <Text key={`act-${i}`} dimColor>{'  '}{l}</Text>),
      <Text key="spacer3"> </Text>,
      <Text key="outcome-header" bold dimColor>Outcome</Text>,
      ...outcomeLines.map((l, i) => <Text key={`out-${i}`}>{'  '}{l}</Text>),
    ]
    const maxScroll = Math.max(0, detailNodes.length - availableRows)
    const scroll = Math.min(detailScroll, maxScroll)
    if (scroll !== detailScroll) setDetailScroll(scroll)
    const visibleDetail = detailNodes.slice(scroll, scroll + availableRows)
    for (let i = 0; i < visibleDetail.length; i++) {
      rightNodes.push(visibleDetail[i])
    }
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
          <Text dimColor wrap="truncate-end">{'─'.repeat(termCols - 4)}</Text>
          <Text bold color="suggestion" wrap="truncate-end">{' '}{workflowTitle(workflow)}</Text>
          <Box>
            <Text dimColor wrap="truncate-end">{' '}{workflowDescription(workflow)}{'  '}{statsText}</Text>
          </Box>
          <Text> </Text>
          <SplitPanel
            leftNodes={leftNodes} rightNodes={rightNodes}
            leftTitle={leftTitle} rightTitle={rightTitle}
            leftWidth={LEFT_WIDTH} rightWidth={RIGHT_WIDTH}
            availableRows={availableRows}
          />
          <Text dimColor italic wrap="truncate-end">{' '}{hints.join(' · ')}</Text>
        </Box>
      </Dialog>
    </Box>
  )
}
