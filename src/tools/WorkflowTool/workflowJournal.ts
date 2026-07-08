import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkflowResumeCacheEntry } from './workflowResumeCache.js'

export type WorkflowJournalStartedEntry = {
  type: 'started'
  key: string
  agentId: string
  phase?: string
  label?: string
  index?: number
  timestamp: number
}

export type WorkflowJournalResultEntry = {
  type: 'result'
  key: string
  agentId: string
  phase?: string
  label?: string
  index?: number
  result: unknown
  timestamp: number
}

export type WorkflowJournalEntry =
  | WorkflowJournalStartedEntry
  | WorkflowJournalResultEntry

function isENOENT(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

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
        completedAt: entry.timestamp,
      },
    ]
  })
}
