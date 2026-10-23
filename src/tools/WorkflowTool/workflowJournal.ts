import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkflowAgentErrorKind } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { isENOENT } from '../../utils/errors.js'
import type { WorkflowResumeCacheEntry } from './workflowResumeCache.js'

// The journal is official 2.1.303's: one JSON line per event under
// <session>/subagents/workflows/<runId>/journal.jsonl with `launched`, `started`, `result`
// and `failed` lines keyed by the v2 chain key. This build adds attempt bookkeeping fields;
// official ignores them, and lines of other types (official's restore markers) are skipped.
type WorkflowJournalAttemptFields = {
  key: string
  agentId: string
  logicalAgentId?: string
  attemptId?: string
  attempt?: number
  retryOfAttemptId?: string
  phase?: string
  label?: string
  index?: number
  timestamp?: number
}

export type WorkflowJournalLaunchedEntry = {
  type: 'launched'
}

export type WorkflowJournalStartedEntry = WorkflowJournalAttemptFields & {
  type: 'started'
}

export type WorkflowJournalResultEntry = WorkflowJournalAttemptFields & {
  type: 'result'
  tokenCount?: number
  toolUseCount?: number
  durationMs?: number
  result: unknown
}

export type WorkflowJournalFailedEntry = WorkflowJournalAttemptFields & {
  type: 'failed'
  /** Missing on official lines, which only record failures. */
  status?: 'failed' | 'skipped' | 'interrupted'
  error?: string
  errorKind?: WorkflowAgentErrorKind
  tokenCount?: number
  toolUseCount?: number
  durationMs?: number
}

export type WorkflowJournalEntry =
  | WorkflowJournalLaunchedEntry
  | WorkflowJournalStartedEntry
  | WorkflowJournalResultEntry
  | WorkflowJournalFailedEntry

export function workflowJournalPath(transcriptDir: string): string {
  return join(transcriptDir, 'journal.jsonl')
}

async function appendWorkflowJournalEntry(
  transcriptDir: string,
  entry: WorkflowJournalEntry,
): Promise<void> {
  await mkdir(transcriptDir, { recursive: true })
  await appendFile(workflowJournalPath(transcriptDir), `${JSON.stringify(entry)}\n`)
}

export async function appendWorkflowJournalLaunched(transcriptDir: string): Promise<void> {
  await appendWorkflowJournalEntry(transcriptDir, { type: 'launched' })
}

export async function appendWorkflowJournalStarted(
  transcriptDir: string,
  entry: Omit<WorkflowJournalStartedEntry, 'type'>,
): Promise<void> {
  await appendWorkflowJournalEntry(transcriptDir, { type: 'started', ...entry })
}

export async function appendWorkflowJournalResult(
  transcriptDir: string,
  entry: Omit<WorkflowJournalResultEntry, 'type'>,
): Promise<void> {
  await appendWorkflowJournalEntry(transcriptDir, { type: 'result', ...entry })
}

export async function appendWorkflowJournalFailed(
  transcriptDir: string,
  entry: Omit<WorkflowJournalFailedEntry, 'type'>,
): Promise<void> {
  await appendWorkflowJournalEntry(transcriptDir, { type: 'failed', ...entry })
}

export async function readWorkflowJournalEntries(
  transcriptDir: string,
): Promise<WorkflowJournalEntry[]> {
  let raw: string
  try {
    raw = await readFile(workflowJournalPath(transcriptDir), 'utf8')
  } catch (error) {
    if (isENOENT(error)) return []
    throw error
  }
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as WorkflowJournalEntry]
      } catch {
        return []
      }
    })
}

export async function readWorkflowJournalCacheEntries(
  transcriptDir: string,
): Promise<WorkflowResumeCacheEntry[]> {
  const entries = await readWorkflowJournalEntries(transcriptDir)
  return entries.flatMap((entry, index): WorkflowResumeCacheEntry[] => {
    if (entry.type !== 'result') return []
    return [
      {
        index: entry.index ?? index,
        identity: entry.key,
        phase: entry.phase,
        label: entry.label,
        result: entry.result,
        completedAt: entry.timestamp ?? 0,
      },
    ]
  })
}
