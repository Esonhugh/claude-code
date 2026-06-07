import * as React from 'react'
import { useMemo, useState } from 'react'
import { Byline } from '../../components/design-system/Byline.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { WorkflowAgentResult } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {
  initialSelectedWorkflowAgentIndex,
  workflowDetailControlText,
} from './workflowDetailSnapshot.js'

type Props = {
  workflow?: LocalWorkflowTaskState
  onBack?: () => void
  onKill?: () => void
  onSkipAgent?: (agentId: string) => void
  onRetryAgent?: (agentId: string) => void
  onPause?: () => void
  onResume?: () => void
}

function completedAgents(task: LocalWorkflowTaskState): number {
  return task.phases.reduce((sum, phase) => sum + phase.completedAgentIds.length, 0)
}

function elapsedSeconds(task: LocalWorkflowTaskState): number {
  return Math.max(0, Math.floor(((task.endTime ?? Date.now()) - task.startTime) / 1000))
}

function workflowTitle(task: LocalWorkflowTaskState): string {
  return task.workflowName ?? task.description.replace(/^Workflow:\s*/i, '')
}

function workflowDescription(task: LocalWorkflowTaskState): string {
  return task.meta?.description ?? task.summary ?? task.description.replace(/^Workflow:\s*/i, '')
}

function displayPhaseId(task: LocalWorkflowTaskState, phaseIndex: number): string {
  return task.meta?.phases?.[phaseIndex]?.title ?? task.phases[phaseIndex]?.id ?? ''
}

function workflowAgentResult(task: LocalWorkflowTaskState, agentId: string): WorkflowAgentResult | undefined {
  return task.results.find(item => item.agentId === agentId) ?? task.phases.flatMap(phase => phase.results).find(item => item.agentId === agentId)
}

function workflowAgentMetrics(task: LocalWorkflowTaskState, agentId: string): { tokenCount: number; toolUseCount: number } {
  const result = workflowAgentResult(task, agentId)
  const liveAgent = task.liveAgents?.[agentId]
  return {
    tokenCount: liveAgent?.tokenCount ?? result?.tokenCount ?? 0,
    toolUseCount: liveAgent?.toolUseCount ?? result?.toolUseCount ?? 0,
  }
}

function agentPhase(task: LocalWorkflowTaskState, agentId: string) {
  return task.phases.find(phase => phase.agentIds.includes(agentId))
}

function selectedAgentPhaseIndex(task: LocalWorkflowTaskState, selectedAgentId: string): number {
  const phase = agentPhase(task, selectedAgentId)
  return phase ? Math.max(0, task.phases.indexOf(phase)) : 0
}

function retryAttempt(agentId: string): number {
  return Number(agentId.match(/ \(retry (\d+)\)$/u)?.[1] ?? 0)
}

function agentStatusLine(task: LocalWorkflowTaskState, agentId: string): string {
  const model = task.defaultModel ?? 'gpt-5.5[1m]'
  const attempt = retryAttempt(agentId)
  const retrySuffix = attempt > 0 ? ` · attempt ${attempt + 1} (user retry)` : ''
  return `${task.status === 'pending' ? 'Stopped' : 'Running'} · ${model}${retrySuffix}`
}

function agentPrompt(task: LocalWorkflowTaskState, selectedAgentId: string): string {
  const phaseIndex = selectedAgentPhaseIndex(task, selectedAgentId)
  return task.liveAgents?.[selectedAgentId]?.prompt ?? task.meta?.phases?.[phaseIndex]?.detail ?? agentPhase(task, selectedAgentId)?.id ?? selectedAgentId
}

function agentActivity(task: LocalWorkflowTaskState, selectedAgentId: string): string {
  if (task.status === 'pending') return task.liveAgents?.[selectedAgentId]?.activity ?? 'Bash(sleep 20)'
  return task.liveAgents?.[selectedAgentId]?.activity ?? workflowAgentResult(task, selectedAgentId)?.output ?? 'Still running…'
}

function agentOutcome(task: LocalWorkflowTaskState, selectedAgentId: string): string {
  if (task.status === 'pending') return 'The workflow stopped before this agent finished.'
  const result = workflowAgentResult(task, selectedAgentId)
  if (!result || result.status === 'running') return 'Still running…'
  return result.output ?? result.error ?? result.status
}

function StatusIcon({ task, selected }: { task: LocalWorkflowTaskState; selected?: boolean }): React.JSX.Element {
  const stopped = task.status === 'pending' && selected
  return <Text color={stopped ? undefined : 'success'}>{stopped ? '◌' : '⏺'}</Text>
}

function WorkflowHeader({ workflow }: { workflow: LocalWorkflowTaskState }): React.JSX.Element {
  const total = workflow.agentCount ?? 0
  const metrics = `${completedAgents(workflow)}/${total} ${total === 1 ? 'agent' : 'agents'} · ${elapsedSeconds(workflow)}s${workflow.status === 'pending' ? ' · paused' : ''}`
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Text bold>{workflowTitle(workflow)}</Text>
        <Text dimColor>{metrics}</Text>
      </Box>
      <Text dimColor>{workflowDescription(workflow)}</Text>
    </Box>
  )
}

function AgentSummaryRow({ workflow, agentId, selected }: { workflow: LocalWorkflowTaskState; agentId: string; selected: boolean }): React.JSX.Element {
  const model = workflow.defaultModel ?? 'gpt-5.5[1m]'
  const { tokenCount, toolUseCount } = workflowAgentMetrics(workflow, agentId)
  return (
    <Box flexDirection="row">
      <Box width={2}><Text color={selected ? 'suggestion' : undefined}>{selected ? '❯' : ' '}</Text></Box>
      <Box width={2}><StatusIcon task={workflow} selected={selected} /></Box>
      <Box width={26}><Text>{agentId}</Text></Box>
      <Box width={16}><Text dimColor>{model}</Text></Box>
      <Text dimColor>{tokenCount} tok · {toolUseCount} {toolUseCount === 1 ? 'tool' : 'tools'}</Text>
    </Box>
  )
}

function PhasePanel({ workflow, selectedAgentId }: { workflow: LocalWorkflowTaskState; selectedAgentId?: string }): React.JSX.Element {
  const selectedPhase = selectedAgentId ? agentPhase(workflow, selectedAgentId) ?? workflow.phases[0] : workflow.phases[0]
  const selectedPhaseIndex = selectedPhase ? workflow.phases.indexOf(selectedPhase) : 0
  return (
    <Box flexDirection="row" gap={2}>
      <Box flexDirection="column" width={18} flexShrink={0}>
        <Text color="suggestion">Phases</Text>
        {workflow.phases.map((phase, index) => {
          const selected = !selectedAgentId && index === selectedPhaseIndex
          return (
            <Box key={phase.id} flexDirection="row">
              <Box width={2}><Text color={selected ? 'suggestion' : undefined}>{selected ? '❯' : ' '}</Text></Box>
              <Box width={3}><Text>{index + 1}</Text></Box>
              <Box width={8}><Text>{displayPhaseId(workflow, index)}</Text></Box>
              <Text dimColor>{phase.completedAgentIds.length}/{phase.agentIds.length}</Text>
            </Box>
          )
        })}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text color="suggestion">{selectedPhase ? `${displayPhaseId(workflow, selectedPhaseIndex)} · ${selectedPhase.agentIds.length} ${selectedPhase.agentIds.length === 1 ? 'agent' : 'agents'}` : 'Agents'}</Text>
        {selectedPhase?.agentIds.map(agentId => (
          <AgentSummaryRow key={agentId} workflow={workflow} agentId={agentId} selected={agentId === selectedAgentId} />
        )) ?? <Text dimColor>No agents</Text>}
      </Box>
    </Box>
  )
}

function AgentDetailPanel({ workflow, selectedAgentId }: { workflow: LocalWorkflowTaskState; selectedAgentId: string }): React.JSX.Element {
  const phaseIndex = selectedAgentPhaseIndex(workflow, selectedAgentId)
  const phase = workflow.phases[phaseIndex]
  const agentIds = phase?.agentIds ?? [selectedAgentId]
  const { tokenCount, toolUseCount } = workflowAgentMetrics(workflow, selectedAgentId)
  return (
    <Box flexDirection="row" gap={2}>
      <Box flexDirection="column" width={24} flexShrink={0}>
        <Text color="suggestion">{displayPhaseId(workflow, phaseIndex)} · {agentIds.length} {agentIds.length === 1 ? 'agent' : 'agents'}</Text>
        {agentIds.map(agentId => {
          const selected = agentId === selectedAgentId
          return (
            <Box key={agentId} flexDirection="row">
              <Box width={2}><Text color={selected ? 'suggestion' : undefined}>{selected ? '❯' : ' '}</Text></Box>
              <Box width={2}><StatusIcon task={workflow} selected={selected} /></Box>
              <Text>{agentId}</Text>
            </Box>
          )
        })}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text color="suggestion">{selectedAgentId}</Text>
        <Text><StatusIcon task={workflow} selected /> {agentStatusLine(workflow, selectedAgentId)}</Text>
        <Text dimColor>{tokenCount} tok · {toolUseCount} tool {toolUseCount === 1 ? 'call' : 'calls'}</Text>
        <Text> </Text>
        <Text color="suggestion">Prompt</Text>
        <Text>{agentPrompt(workflow, selectedAgentId)}</Text>
        <Text> </Text>
        <Text color="suggestion">Activity</Text>
        <Text>{agentActivity(workflow, selectedAgentId)}</Text>
        <Text> </Text>
        <Text color="suggestion">Outcome</Text>
        <Text>{agentOutcome(workflow, selectedAgentId)}</Text>
      </Box>
    </Box>
  )
}

function WorkflowDetailContent({ workflow, selectedAgentId, showAgentDetail }: { workflow: LocalWorkflowTaskState; selectedAgentId?: string; showAgentDetail: boolean }): React.JSX.Element {
  return (
    <Box flexDirection="column" gap={1}>
      <WorkflowHeader workflow={workflow} />
      {showAgentDetail && selectedAgentId ? (
        <AgentDetailPanel workflow={workflow} selectedAgentId={selectedAgentId} />
      ) : (
        <PhasePanel workflow={workflow} selectedAgentId={selectedAgentId} />
      )}
      <Text dimColor>{workflowDetailControlText(workflow, { selectedAgentId, showAgentDetail })}</Text>
    </Box>
  )
}

export function WorkflowDetailDialog({
  workflow,
  onBack,
  onKill,
  onSkipAgent,
  onRetryAgent,
  onPause,
  onResume,
}: Props): React.JSX.Element {
  const close = onBack ?? (() => undefined)
  const agentIds = useMemo(
    () => workflow?.phases.flatMap(phase => phase.agentIds) ?? [],
    [workflow],
  )
  const [selectedAgentIndex, setSelectedAgentIndex] = useState<number | null>(() => initialSelectedWorkflowAgentIndex(workflow))
  const [showAgentDetail, setShowAgentDetail] = useState(false)
  const selectedAgentId = selectedAgentIndex === null ? undefined : agentIds[selectedAgentIndex]
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'left' && showAgentDetail) {
      e.preventDefault()
      setShowAgentDetail(false)
    } else if (e.key === 'left' && onBack) {
      e.preventDefault()
      onBack()
    } else if (e.key === 'return' && selectedAgentId) {
      e.preventDefault()
      setShowAgentDetail(true)
    } else if (e.key === 'up' && selectedAgentIndex !== null) {
      e.preventDefault()
      setShowAgentDetail(false)
      setSelectedAgentIndex(Math.max(0, selectedAgentIndex - 1))
    } else if (e.key === 'down') {
      e.preventDefault()
      setShowAgentDetail(false)
      setSelectedAgentIndex(prev => Math.min(agentIds.length - 1, prev === null ? 0 : prev + 1))
    } else if (e.key === 'x' && workflow?.status === 'running') {
      e.preventDefault()
      if (selectedAgentId && onSkipAgent) onSkipAgent(selectedAgentId)
      else onKill?.()
    } else if (e.key === 'r' && workflow?.status === 'running' && selectedAgentId && onRetryAgent) {
      e.preventDefault()
      onRetryAgent(selectedAgentId)
    } else if (e.key === 'p' && workflow?.status === 'running' && onPause) {
      e.preventDefault()
      onPause()
    } else if (e.key === 'p' && workflow?.status === 'pending' && onResume) {
      e.preventDefault()
      onResume()
    }
  }

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title="Dynamic workflow"
        subtitle={workflow ? workflow.workflowName ?? workflow.description : undefined}
        onCancel={showAgentDetail ? () => setShowAgentDetail(false) : close}
        color="suggestion"
        inputGuide={exitState =>
          exitState.pending ? (
            <Text>Press {exitState.keyName} again to exit</Text>
          ) : (
            <Byline>
              {onBack && <KeyboardShortcutHint shortcut="Esc/←" action="back" />}
              {workflow?.status === 'running' && selectedAgentId && onSkipAgent && (
                <KeyboardShortcutHint shortcut="x" action="stop" />
              )}
              {workflow?.status === 'running' && selectedAgentId && onRetryAgent && (
                <KeyboardShortcutHint shortcut="r" action="restart" />
              )}
              {workflow?.status === 'running' && !selectedAgentId && onKill && (
                <KeyboardShortcutHint shortcut="x" action="cancel workflow" />
              )}
            </Byline>
          )
        }
      >
        {workflow ? (
          <WorkflowDetailContent workflow={workflow} selectedAgentId={selectedAgentId} showAgentDetail={showAgentDetail} />
        ) : (
          <Text>Workflow details unavailable in this recovery build.</Text>
        )}
      </Dialog>
    </Box>
  )
}
