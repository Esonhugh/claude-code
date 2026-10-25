import {
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
} from '../../constants/xml.js'
import type { AgentId } from '../../types/ids.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { escapeXml } from '../../utils/xml.js'

export const MONITOR_EVENT_TAG = 'event'

const BATCH_WINDOW_MS = 200
const MAX_LINE_CHARS = 500
const MAX_BATCH_CHARS = 3000
const MAX_PENDING_BYTES = 1_048_576
const BUCKET_CAPACITY = 10
const BUCKET_REFILL_MS = 2000
const SUPPRESSION_KILL_MS = 30_000

export function buildMonitorEventNotification(
  taskId: string,
  description: string,
  body: string,
): string {
  return `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${escapeXml(taskId)}</${TASK_ID_TAG}>
<${SUMMARY_TAG}>${escapeXml(`Monitor event: "${description}"`)}</${SUMMARY_TAG}>
<${MONITOR_EVENT_TAG}>${escapeXml(body)}</${MONITOR_EVENT_TAG}>
</${TASK_NOTIFICATION_TAG}>`
}

function suppressedNotice(count: number): string {
  return `[${count} events suppressed — output rate too high. Consider using TaskStop to restart this monitor with a more selective filter.]`
}

function truncateLine(line: string): string {
  return line.length > MAX_LINE_CHARS
    ? line.slice(0, MAX_LINE_CHARS) + '...(truncated)'
    : line
}

export type MonitorEventStreamOptions = {
  /** Filled in once the shell task is registered; output can start earlier. */
  taskRef: { id?: string }
  description: string
  agentId?: AgentId
  /** Stops the underlying task; returns false when it was no longer running. */
  killTask: () => boolean
  now?: () => number
  schedule?: (fn: () => void, ms: number) => () => void
  notify?: (value: string) => void
}

export type MonitorEventStream = {
  onData: (chunk: string) => void
  /** Deliver pending lines now; `final` also emits a trailing partial line. */
  flush: (final?: boolean) => void
  /** Housekeeping notice that bypasses batching and rate limiting. */
  notice: (text: string) => void
  close: () => void
  isClosed: () => boolean
  eventCount: () => number
}

/**
 * Turns raw stdout chunks into task notifications: complete lines are batched
 * for 200ms, each batch is one event, and a token bucket (10 events, +1 per
 * 2s) suppresses floods. A monitor still suppressing after 30s is stopped.
 */
export function createMonitorEventStream(
  options: MonitorEventStreamOptions,
): MonitorEventStream {
  const { taskRef, description, agentId, killTask } = options
  const now = options.now ?? Date.now
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    })
  const notify =
    options.notify ??
    ((value: string) => {
      void enqueuePendingNotification({
        value,
        mode: 'task-notification',
        priority: 'next',
        agentId,
      })
    })

  let closed = false
  let delivered = 0
  let pendingText = ''
  let lines: string[] = []
  let cancelTimer: (() => void) | null = null

  let tokens = BUCKET_CAPACITY
  let lastRefill = now()
  let suppressed = 0
  let suppressionStartedAt: number | undefined
  let lastSuppressedAt: number | undefined

  function emit(body: string): void {
    notify(buildMonitorEventNotification(taskRef.id ?? '', description, body))
  }

  function tryConsume(): boolean {
    const t = now()
    const refills = Math.floor((t - lastRefill) / BUCKET_REFILL_MS)
    if (refills > 0) {
      tokens = Math.min(BUCKET_CAPACITY, tokens + refills)
      lastRefill += refills * BUCKET_REFILL_MS
    }
    if (tokens > 0) {
      tokens--
      return true
    }
    return false
  }

  function deliver(batch: string): void {
    if (closed) return
    if (tryConsume()) {
      if (suppressed > 0) {
        emit(suppressedNotice(suppressed))
        suppressed = 0
        if (
          lastSuppressedAt !== undefined &&
          now() - lastSuppressedAt > BUCKET_REFILL_MS * 3
        ) {
          suppressionStartedAt = undefined
        }
      }
      delivered++
      emit(batch)
      return
    }
    suppressed++
    lastSuppressedAt = now()
    suppressionStartedAt ??= lastSuppressedAt
    if (now() - suppressionStartedAt > SUPPRESSION_KILL_MS) {
      const seconds = Math.round((now() - suppressionStartedAt) / 1000)
      const count = suppressed
      close()
      if (killTask()) {
        emit(
          `[Monitor stopped — too much output (${count} events suppressed over ${seconds}s). Restart with a more selective source.]`,
        )
      }
    }
  }

  function takeBatch(final: boolean): string | undefined {
    cancelTimer?.()
    cancelTimer = null
    const tail = pendingText.trim()
    if (final && tail) {
      lines.push(truncateLine(tail))
      pendingText = ''
    }
    if (lines.length === 0) return undefined
    let batch = lines.join('\n')
    lines = []
    if (batch.length > MAX_BATCH_CHARS) {
      batch = batch.slice(0, MAX_BATCH_CHARS) + '\n...(truncated)'
    }
    return batch
  }

  function flush(final = false): void {
    const batch = takeBatch(final)
    if (batch !== undefined) deliver(batch)
  }

  function close(): void {
    closed = true
    cancelTimer?.()
    cancelTimer = null
    lines = []
    pendingText = ''
  }

  function onData(chunk: string): void {
    if (closed) return
    pendingText += chunk
    if (pendingText.length > MAX_PENDING_BYTES) {
      pendingText = pendingText.slice(-MAX_PENDING_BYTES)
    }
    let newline: number
    while ((newline = pendingText.indexOf('\n')) !== -1) {
      const line = pendingText.slice(0, newline).trim()
      pendingText = pendingText.slice(newline + 1)
      if (line) lines.push(truncateLine(line))
    }
    if (lines.length > 0 && !cancelTimer) {
      cancelTimer = schedule(() => {
        cancelTimer = null
        flush()
      }, BATCH_WINDOW_MS)
    }
  }

  return {
    onData,
    flush,
    notice: emit,
    close,
    isClosed: () => closed,
    eventCount: () => delivered,
  }
}
