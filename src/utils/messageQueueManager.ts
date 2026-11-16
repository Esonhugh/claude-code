import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomBytes, randomUUID } from 'crypto'
import type { Permutations } from 'src/types/utils.js'
import { getSessionId } from '../bootstrap/state.js'
import { toolsUsedNames } from '../tools/PollTool/toolsUsed.js'
import type { AppState } from '../state/AppState.js'
import type {
  QueueOperation,
  QueueOperationMessage,
} from '../types/messageQueueTypes.js'
import type { AgentId } from '../types/ids.js'
import type {
  EditablePromptInputMode,
  PromptInputMode,
  QueuedCommand,
  QueuedPollEvent,
  QueuePriority,
} from '../types/textInputTypes.js'
import type { PastedContent } from './config.js'
import { extractTextContent } from './messages.js'
import { objectGroupBy } from './objectGroupBy.js'
import { recordQueueOperation } from './sessionStorage.js'
import { createSignal } from './signal.js'
import { enqueueInboundMessage } from './inboundMessageQueue.js'
import { logForDebugging } from './debug.js'

export type SetAppState = (f: (prev: AppState) => AppState) => void

// ============================================================================
// Logging helper
// ============================================================================

/** Rewrites a queue record's text before it is kept (mods `session.append`, door `queue`). */
export type QueueRecordRewriter = (text: string, origin: QueuedCommand['origin']) => Promise<string> | undefined

let queueRecordRewriter: QueueRecordRewriter | undefined
let pendingRecords: Promise<void> | undefined

export function setQueueRecordRewriter(rewriter: QueueRecordRewriter | undefined): void {
  queueRecordRewriter = rewriter
}

function logOperation(
  operation: QueueOperation,
  content?: string,
  origin?: QueuedCommand['origin'],
  removal?: { reason: string; commandUuid?: string },
): void {
  const sessionId = getSessionId()
  const queueOp: QueueOperationMessage = {
    type: 'queue-operation',
    operation,
    timestamp: new Date().toISOString(),
    sessionId,
    ...(content !== undefined && { content }),
    ...(removal && { reason: removal.reason }),
    ...(removal?.commandUuid !== undefined && { commandUuid: removal.commandUuid }),
  }
  const rewritten = content === undefined ? undefined : queueRecordRewriter?.(content, origin)
  if (!rewritten && !pendingRecords) {
    void recordQueueOperation(queueOp)
    return
  }
  // Records keep their order while one waits on its hooks.
  const record = (pendingRecords ?? Promise.resolve()).then(async () => {
    const text = rewritten ? await rewritten.catch(() => content) : content
    await recordQueueOperation(text === undefined ? queueOp : { ...queueOp, content: text })
  }).catch(() => {})
  pendingRecords = record
  void record.then(() => {
    if (pendingRecords === record) pendingRecords = undefined
  })
}

// ============================================================================
// Unified command queue (module-level, independent of React state)
//
// All commands — user input, task notifications, orphaned permissions — go
// through this single queue. React components subscribe via
// useSyncExternalStore (subscribeToCommandQueue / getCommandQueueSnapshot).
// Non-React code (print.ts streaming loop) reads directly via
// getCommandQueue() / getCommandQueueLength().
//
// Priority determines dequeue order: 'now' > 'next' > 'later'.
// Within the same priority, commands are processed FIFO.
// ============================================================================

const commandQueue: QueuedCommand[] = []

function settleRemovedCommands(commands: readonly QueuedCommand[]): void {
  for (const command of commands) {
    command.promptSubmitReceipt?.admit({drop:'the prompt was removed from the queue before it ran'})
    command.commandRunReceipt?.cancel(new Error('Queued command removed before execution'))
  }
}

/** Frozen snapshot — recreated on every mutation for useSyncExternalStore. */
let snapshot: readonly QueuedCommand[] = Object.freeze([])
const queueChanged = createSignal()

function notifySubscribers(): void {
  snapshot = Object.freeze([...commandQueue])
  queueChanged.emit()
}

// ============================================================================
// useSyncExternalStore interface
// ============================================================================

/**
 * Subscribe to command queue changes.
 * Compatible with React's useSyncExternalStore.
 */
export const subscribeToCommandQueue = queueChanged.subscribe

/**
 * Get current snapshot of the command queue.
 * Compatible with React's useSyncExternalStore.
 * Returns a frozen array that only changes reference on mutation.
 */
export function getCommandQueueSnapshot(): readonly QueuedCommand[] {
  return snapshot
}

// ============================================================================
// Read operations (for non-React code)
// ============================================================================

/**
 * Get a mutable copy of the current queue.
 * Use for one-off reads where you need the actual commands.
 */
export function getCommandQueue(): QueuedCommand[] {
  return [...commandQueue]
}

/**
 * Get the current queue length without copying.
 */
export function getCommandQueueLength(): number {
  return commandQueue.length
}

/**
 * Queued commands that will start or join a turn. A poll event that doesn't
 * wake waits for the next prompt, so the spinner doesn't count it.
 */
export function countCommandsAwaitingTurn(): number {
  return commandQueue.filter(
    cmd => cmd.mode !== 'poll-event' || (cmd.pollEvent !== undefined && pollEventWakes(cmd.pollEvent)),
  ).length
}

/**
 * Check if there are commands in the queue.
 */
export function hasCommandsInQueue(): boolean {
  return commandQueue.length > 0
}

/**
 * Trigger a re-check by notifying subscribers.
 * Use after async processing completes to ensure remaining commands
 * are picked up by useSyncExternalStore consumers.
 */
export function recheckCommandQueue(): void {
  if (commandQueue.length > 0) {
    notifySubscribers()
  }
}

// ============================================================================
// Write operations
// ============================================================================

/**
 * Add a command to the queue.
 * Used for user-initiated commands (prompt, bash, orphaned-permission).
 * Defaults priority to 'next' (processed before task notifications).
 */
function enqueueCommand(command: QueuedCommand): QueuedCommand {
  const queued = { ...command, priority: command.priority ?? 'next' }
  commandQueue.push(queued)
  notifySubscribers()
  logOperation(
    'enqueue',
    typeof command.value === 'string' ? command.value : undefined,
    command.origin,
  )
  return queued
}

export function enqueue(command: QueuedCommand): void {
  enqueueCommand(command)
}

/** Enqueue and return the stored object for identity-based cancellation. */
export function enqueueTracked(command: QueuedCommand): QueuedCommand {
  return enqueueCommand(command)
}

/**
 * Add a task notification to the queue.
 * Convenience wrapper that defaults priority to 'later' so user input
 * is never starved by system messages.
 */
export function enqueuePendingNotification(command: QueuedCommand): void | Promise<void> {
  const pending: QueuedCommand = { ...command, priority: command.priority ?? 'later' }
  if (command.mode === 'task-notification' && command.agentId === undefined) {
    return enqueueInboundMessage(pending, { kind: 'task-notification' }).then(() => {}, () => {
      logForDebugging('[Mods] task notification receive interrupted before enqueue')
    })
  }
  enqueue(pending)
}

// ============================================================================
// Poll events (official 2.1.325 chunk-jsrfnb7z.js and the queue's
// enqueuePollEvent / drainPollEventChunk)
// ============================================================================

/** Official Zk and Cge: the kinds REPL evals produce. */
export const REPL_EVAL_EVENT_KIND = 'repl-eval'
export const REPL_STATUS_EVENT_KIND = 'repl-status'

/** Official H6t and SBe: one delivery holds at most this many events and bytes (always at least one event). */
export const POLL_EVENT_CHUNK_EVENTS = 20
export const POLL_EVENT_CHUNK_BYTES = 32_768
/** Official V and Tge (`L6t`): an envelope's cap after nonce stamping, larger for an eval's outcome. */
export const POLL_EVENT_REPL_EVAL_BYTES = 163_840
export const POLL_EVENT_BYTES = 49_152
/** Official yBe: poll events the queue holds at most. */
export const POLL_EVENT_QUEUE_CAP = 1000
const POLL_EVENT_KIND = /^[a-z][a-z0-9-]{0,63}$/
/** Official x: random bytes in a nonce. */
const NONCE_BYTES = 6

export type PollEventInput = {
  kind: string
  /** A single `<event kind=… at=…>` element; the queue stamps its nonce. */
  element: string
  /** Defaults to true. */
  wake?: boolean
  startsTurn?: false
  /** The subagent the event is for (undefined: the main thread). */
  agentId?: AgentId
}

function pollEventCap(kind: string): number {
  return kind === REPL_EVAL_EVENT_KIND ? POLL_EVENT_REPL_EVAL_BYTES : POLL_EVENT_BYTES
}

/** Official `bpn` (element form): the nonce goes in as the first attribute. */
function stampNonce(element: string, nonce: string): string {
  return `<event nonce="${nonce}"${element.slice('<event'.length)}`
}

function isPollEventFor(cmd: QueuedCommand, agentId: AgentId | undefined): boolean {
  return cmd.mode === 'poll-event' && cmd.agentId === agentId
}

/** Official `uzs`: an event starts a turn unless held, told not to wake, or told not to start one. */
export function pollEventWakes(event: { passive?: boolean; wake?: boolean; startsTurn?: false }): boolean {
  return event.passive !== true && event.wake === true && event.startsTurn !== false
}

/** Official `DBr`: whether a queued command is an eval's outcome that starts a turn. */
export function isWakingReplEvalEvent(cmd: QueuedCommand): boolean {
  return (
    cmd.mode === 'poll-event' &&
    cmd.pollEvent?.kind === REPL_EVAL_EVENT_KIND &&
    pollEventWakes({ wake: cmd.pollEvent.wake, startsTurn: cmd.pollEvent.startsTurn })
  )
}

/**
 * Official `enqueuePollEvent`: stamps a nonce on the element and queues it,
 * a waking one at `next` priority and the rest at `later`. Throws when the
 * queue is full or the envelope is over its cap; the promise settles when a
 * delivery takes the event or it is dropped undelivered.
 */
export function enqueuePollEvent(input: PollEventInput): Promise<void> {
  const queued = commandQueue.filter(cmd => cmd.mode === 'poll-event').length
  if (queued + 1 > POLL_EVENT_QUEUE_CAP) throw new Error(`poll event rejected: ${POLL_EVENT_QUEUE_CAP} events already queued`)
  if (!POLL_EVENT_KIND.test(input.kind))
    throw new Error('poll event rejected: invalid kind (a lowercase letter, then lowercase letters, digits and hyphens, at most 64 characters)')
  const nonce = randomBytes(NONCE_BYTES).toString('base64url')
  const envelope = stampNonce(input.element, nonce)
  const bytes = Buffer.byteLength(envelope, 'utf8')
  if (bytes > pollEventCap(input.kind))
    throw new Error(`poll event rejected: envelope is ${bytes} bytes after nonce stamping (cap ${pollEventCap(input.kind)})`)
  const wake = input.wake ?? true
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  // Nobody has to listen for a drop.
  promise.catch(() => {})
  const pollEvent: QueuedPollEvent = {
    kind: input.kind,
    envelope,
    nonce,
    wake,
    ...(input.startsTurn === false && { startsTurn: false }),
    timestamp: new Date().toISOString(),
    toolsUsed: toolsUsedNames(),
    settleDelivered: () => resolve(),
    settleDropped: reject,
  }
  enqueueCommand({
    value: envelope,
    mode: 'poll-event',
    agentId: input.agentId,
    priority: wake ? 'next' : 'later',
    uuid: randomUUID(),
    isMeta: true,
    pollEvent,
  })
  return promise
}

/** Official `R3n`: the oldest events that fit one delivery. */
export function takePollEventChunk(commands: readonly QueuedCommand[]): QueuedCommand[] {
  const chunk: QueuedCommand[] = []
  let bytes = 0
  for (const cmd of commands) {
    const size = Buffer.byteLength(cmd.pollEvent?.envelope ?? '', 'utf8')
    if (chunk.length > 0 && (chunk.length + 1 > POLL_EVENT_CHUNK_EVENTS || bytes + size > POLL_EVENT_CHUNK_BYTES)) break
    chunk.push(cmd)
    bytes += size
  }
  return chunk
}

/** Official `countPendingWakePollEvents`: waking events queued for the agent. */
export function countPendingWakePollEvents(agentId: AgentId | undefined): number {
  return commandQueue.filter(cmd => isPollEventFor(cmd, agentId) && cmd.pollEvent?.wake === true).length
}

/** Official `countRemainingWakePollEventsAfter`: waking events left once `taken` is delivered. */
export function countRemainingWakePollEventsAfter(taken: readonly QueuedCommand[]): number {
  const agentId = taken.find(cmd => cmd.mode === 'poll-event')?.agentId
  const inTaken = taken.filter(cmd => cmd.pollEvent?.wake === true).length
  return Math.max(0, countPendingWakePollEvents(agentId) - inTaken)
}

/** Official `drainPollEventChunk`: takes the agent's oldest events that fit one delivery out of the queue. */
export function drainPollEventChunk(agentId: AgentId | undefined): { commands: QueuedCommand[]; remainingWakeCount: number } {
  const chunk = takePollEventChunk(commandQueue.filter(cmd => isPollEventFor(cmd, agentId)))
  if (chunk.length === 0) return { commands: [], remainingWakeCount: 0 }
  const taken = new Set(chunk)
  const rest = commandQueue.filter(cmd => !taken.has(cmd))
  commandQueue.length = 0
  commandQueue.push(...rest)
  notifySubscribers()
  for (const _cmd of chunk) logOperation('dequeue')
  return { commands: chunk, remainingWakeCount: countPendingWakePollEvents(agentId) }
}

/** Official `OKe`: the events went out in a delivery. */
export function settlePollEventsDelivered(commands: readonly QueuedCommand[]): void {
  for (const cmd of commands) cmd.pollEvent?.settleDelivered?.()
}

/** Official `c0`: the events will never be delivered. */
export function settlePollEventsDropped(commands: readonly QueuedCommand[], why: string): void {
  for (const cmd of commands) cmd.pollEvent?.settleDropped?.(new Error(`poll event discarded undelivered: ${why}`))
}

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2,
}

/**
 * Remove and return the highest-priority command, or undefined if empty.
 * Within the same priority level, commands are dequeued FIFO.
 *
 * An optional `filter` narrows the candidates: only commands for which the
 * predicate returns `true` are considered. Non-matching commands stay in the
 * queue untouched. This lets between-turn drains (SDK, REPL) restrict to
 * main-thread commands (`cmd.agentId === undefined`) without restructuring
 * the existing while-loop patterns.
 */
export function dequeue(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  if (commandQueue.length === 0) {
    return undefined
  }

  // Find the first command with the highest priority (respecting filter)
  let bestIdx = -1
  let bestPriority = Infinity
  for (let i = 0; i < commandQueue.length; i++) {
    const cmd = commandQueue[i]!
    if (filter && !filter(cmd)) continue
    const priority = PRIORITY_ORDER[cmd.priority ?? 'next']
    if (priority < bestPriority) {
      bestIdx = i
      bestPriority = priority
    }
  }

  if (bestIdx === -1) return undefined

  const [dequeued] = commandQueue.splice(bestIdx, 1)
  notifySubscribers()
  logOperation('dequeue')
  return dequeued
}

/**
 * Remove and return all commands from the queue.
 * Logs a dequeue operation for each command.
 */
export function dequeueAll(): QueuedCommand[] {
  if (commandQueue.length === 0) {
    return []
  }

  const commands = [...commandQueue]
  commandQueue.length = 0
  notifySubscribers()

  for (const _cmd of commands) {
    logOperation('dequeue')
  }

  return commands
}

/**
 * Return the highest-priority command without removing it, or undefined if empty.
 * Accepts an optional `filter` — only commands passing the predicate are considered.
 */
export function peek(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  if (commandQueue.length === 0) {
    return undefined
  }
  let bestIdx = -1
  let bestPriority = Infinity
  for (let i = 0; i < commandQueue.length; i++) {
    const cmd = commandQueue[i]!
    if (filter && !filter(cmd)) continue
    const priority = PRIORITY_ORDER[cmd.priority ?? 'next']
    if (priority < bestPriority) {
      bestIdx = i
      bestPriority = priority
    }
  }
  if (bestIdx === -1) return undefined
  return commandQueue[bestIdx]
}

/**
 * Remove and return all commands matching a predicate, preserving priority order.
 * Non-matching commands stay in the queue.
 */
export function dequeueAllMatching(
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const matched: QueuedCommand[] = []
  const remaining: QueuedCommand[] = []
  for (const cmd of commandQueue) {
    if (predicate(cmd)) {
      matched.push(cmd)
    } else {
      remaining.push(cmd)
    }
  }
  if (matched.length === 0) {
    return []
  }
  commandQueue.length = 0
  commandQueue.push(...remaining)
  notifySubscribers()
  for (const _cmd of matched) {
    logOperation('dequeue')
  }
  return matched
}

/**
 * Remove specific commands from the queue by reference identity.
 * Callers must pass the same object references that are in the queue
 * (e.g. from getCommandsByMaxPriority). Logs a 'remove' operation for each.
 */
export function remove(commandsToRemove: QueuedCommand[]): void {
  if (commandsToRemove.length === 0) {
    return
  }

  const removed: QueuedCommand[] = []
  for (let i = commandQueue.length - 1; i >= 0; i--) {
    if (commandsToRemove.includes(commandQueue[i]!)) {
      removed.unshift(commandQueue.splice(i, 1)[0]!)
    }
  }

  if (removed.length) notifySubscribers()

  settleRemovedCommands(removed)
  for (const _cmd of removed) {
    logOperation('remove')
  }
}

/**
 * Official 2.1.325 `consume`: takes commands a turn delivered out of the
 * queue. Each `remove` record keeps the command's text, the reason and the
 * command's uuid.
 */
export function consume(commands: readonly QueuedCommand[], { reason }: { reason: string }): QueuedCommand[] {
  const removed: QueuedCommand[] = []
  for (let i = commandQueue.length - 1; i >= 0; i--) {
    if (commands.includes(commandQueue[i]!)) {
      removed.unshift(commandQueue.splice(i, 1)[0]!)
    }
  }
  if (removed.length === 0) return removed
  notifySubscribers()
  for (const cmd of removed) {
    logOperation('remove', typeof cmd.value === 'string' ? cmd.value : undefined, cmd.origin, {
      reason,
      commandUuid: cmd.uuid,
    })
  }
  return removed
}

/**
 * Remove commands matching a predicate.
 * Returns the removed commands.
 */
export function removeByFilter(
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const removed: QueuedCommand[] = []
  for (let i = commandQueue.length - 1; i >= 0; i--) {
    if (predicate(commandQueue[i]!)) {
      removed.unshift(commandQueue.splice(i, 1)[0]!)
    }
  }

  if (removed.length > 0) {
    notifySubscribers()
    settleRemovedCommands(removed)
    for (const _cmd of removed) {
      logOperation('remove')
    }
  }

  return removed
}

/**
 * Clear all commands from the queue.
 * Used by ESC cancellation to discard queued notifications.
 */
export function clearCommandQueue(): void {
  if (commandQueue.length === 0) {
    return
  }
  const removed = commandQueue.splice(0)
  notifySubscribers()
  settleRemovedCommands(removed)
}

/**
 * Clear all commands and reset snapshot.
 * Used for test cleanup.
 */
export function resetCommandQueue(): void {
  const removed = commandQueue.splice(0)
  snapshot = Object.freeze([])
  settleRemovedCommands(removed)
}

// ============================================================================
// Editable mode helpers
// ============================================================================

// @ts-ignore - recovered code
const NON_EDITABLE_MODES = new Set<PromptInputMode>([
  'task-notification',
  'poll-event',
// @ts-ignore - recovered code
] satisfies Permutations<Exclude<PromptInputMode, EditablePromptInputMode>>)

export function isPromptInputModeEditable(
  mode: PromptInputMode,
): mode is EditablePromptInputMode {
  return !NON_EDITABLE_MODES.has(mode)
}

/**
 * Whether this queued command can be pulled into the input buffer via UP/ESC.
 * System-generated commands (proactive ticks, scheduled tasks, plan
 * verification, channel messages) contain raw XML and must not leak into
 * the user's input.
 */
export function isQueuedCommandEditable(cmd: QueuedCommand): boolean {
  return isPromptInputModeEditable(cmd.mode) && !cmd.isMeta && !cmd.promptSubmitReceipt && !cmd.commandRunReceipt
}

/**
 * Whether this queued command should render in the queue preview under the
 * prompt. Superset of editable — channel messages show (so the keyboard user
 * sees what arrived) but stay non-editable (raw XML).
 */
export function isQueuedCommandVisible(cmd: QueuedCommand): boolean {
  if (
    (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
    // @ts-ignore - recovered code
    cmd.origin?.kind === 'channel'
  )
    return true
  return isQueuedCommandEditable(cmd)
}

/**
 * Extract text from a queued command value.
 * For strings, returns the string.
 * For ContentBlockParam[], extracts text from text blocks.
 */
function extractTextFromValue(value: string | ContentBlockParam[]): string {
  return typeof value === 'string' ? value : extractTextContent(value, '\n')
}

/**
 * Extract images from ContentBlockParam[] and convert to PastedContent format.
 * Returns empty array for string values or if no images found.
 */
function extractImagesFromValue(
  value: string | ContentBlockParam[],
  startId: number,
): PastedContent[] {
  if (typeof value === 'string') {
    return []
  }

  const images: PastedContent[] = []
  let imageIndex = 0
  for (const block of value) {
    if (block.type === 'image' && block.source.type === 'base64') {
      images.push({
        id: startId + imageIndex,
        type: 'image',
        content: block.source.data,
        mediaType: block.source.media_type,
        filename: `image${imageIndex + 1}`,
      })
      imageIndex++
    }
  }
  return images
}

export type PopAllEditableResult = {
  text: string
  cursorOffset: number
  images: PastedContent[]
}

/**
 * Pop all editable commands and combine them with current input for editing.
 * Notification modes (task-notification) are left in the queue
 * to be auto-processed later.
 * Returns object with combined text, cursor offset, and images to restore.
 * Returns undefined if no editable commands in queue.
 */
export function popAllEditable(
  currentInput: string,
  currentCursorOffset: number,
): PopAllEditableResult | undefined {
  if (commandQueue.length === 0) {
    return undefined
  }

  const { editable = [], nonEditable = [] } = objectGroupBy(
    [...commandQueue],
    cmd => (isQueuedCommandEditable(cmd) ? 'editable' : 'nonEditable'),
  )

  if (editable.length === 0) {
    return undefined
  }

  // Extract text from queued commands (handles both strings and ContentBlockParam[])
  const queuedTexts = editable.map(cmd => extractTextFromValue(cmd.value))
  const newInput = [...queuedTexts, currentInput].filter(Boolean).join('\n')

  // Calculate cursor offset: length of joined queued commands + 1 + current cursor offset
  const cursorOffset = queuedTexts.join('\n').length + 1 + currentCursorOffset

  // Extract images from queued commands
  const images: PastedContent[] = []
  let nextImageId = Date.now() // Use timestamp as base for unique IDs
  for (const cmd of editable) {
    // handlePromptSubmit queues images in pastedContents (value is a string).
    // Preserve the original PastedContent id so imageStore lookups still work.
    if (cmd.pastedContents) {
      for (const content of Object.values(cmd.pastedContents)) {
        if (content.type === 'image') {
          images.push(content)
        }
      }
    }
    // Bridge/remote commands may embed images directly in ContentBlockParam[].
    const cmdImages = extractImagesFromValue(cmd.value, nextImageId)
    images.push(...cmdImages)
    nextImageId += cmdImages.length
  }

  for (const command of editable) {
    logOperation(
      'popAll',
      typeof command.value === 'string' ? command.value : undefined,
      command.origin,
    )
  }

  // Replace queue contents with only the non-editable commands
  commandQueue.length = 0
  commandQueue.push(...nonEditable)
  notifySubscribers()

  return { text: newInput, cursorOffset, images }
}

// ============================================================================
// Backward-compatible aliases (deprecated — prefer new names)
// ============================================================================

/** @deprecated Use subscribeToCommandQueue */
export const subscribeToPendingNotifications = subscribeToCommandQueue

/** @deprecated Use getCommandQueueSnapshot */
export function getPendingNotificationsSnapshot(): readonly QueuedCommand[] {
  return snapshot
}

/** @deprecated Use hasCommandsInQueue */
export const hasPendingNotifications = hasCommandsInQueue

/** @deprecated Use getCommandQueueLength */
export const getPendingNotificationsCount = getCommandQueueLength

/** @deprecated Use recheckCommandQueue */
export const recheckPendingNotifications = recheckCommandQueue

/** @deprecated Use dequeue */
export function dequeuePendingNotification(): QueuedCommand | undefined {
  return dequeue()
}

/** @deprecated Use resetCommandQueue */
export const resetPendingNotifications = resetCommandQueue

/** @deprecated Use clearCommandQueue */
export const clearPendingNotifications = clearCommandQueue

/**
 * Get commands at or above a given priority level without removing them.
 * Useful for mid-chain draining where only urgent items should be processed.
 *
 * Priority order: 'now' (0) > 'next' (1) > 'later' (2).
 * Passing 'now' returns only now-priority commands; 'later' returns everything.
 */
export function getCommandsByMaxPriority(
  maxPriority: QueuePriority,
): QueuedCommand[] {
  const threshold = PRIORITY_ORDER[maxPriority]
  return commandQueue.filter(
    cmd => PRIORITY_ORDER[cmd.priority ?? 'next'] <= threshold,
  )
}

/**
 * Returns true if the command is a slash command that should be routed through
 * processSlashCommand rather than sent to the model as text.
 *
 * Commands with `skipSlashCommands` (e.g. bridge/CCR messages) are NOT treated
 * as slash commands — their text is meant for the model.
 */
export function isSlashCommand(cmd: QueuedCommand): boolean {
  return (
    typeof cmd.value === 'string' &&
    cmd.value.trim().startsWith('/') &&
    !cmd.skipSlashCommands
  )
}
