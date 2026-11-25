import type { QueuedCommand } from '../types/textInputTypes.js'
import { logForDebugging } from './debug.js'
import {
  dequeue,
  dequeueAllMatching,
  hasCommandsInQueue,
  isDrainableMainThreadCommand,
  peek,
  pollEventWakes,
} from './messageQueueManager.js'

type ProcessQueueParams = {
  executeInput: (commands: QueuedCommand[]) => Promise<void>
}

type ProcessQueueResult = {
  processed: boolean
}

/**
 * Check if a queued command is a slash command (value starts with '/').
 */
function isSlashCommand(cmd: QueuedCommand): boolean {
  if (typeof cmd.value === 'string') {
    return cmd.value.trim().startsWith('/')
  }
  // For ContentBlockParam[], check the first text block
  for (const block of cmd.value) {
    if (block.type === 'text') {
      return block.text.trim().startsWith('/')
    }
  }
  return false
}

/**
 * Processes commands from the queue.
 *
 * Slash commands (starting with '/') and bash-mode commands are processed
 * one at a time so each goes through the executeInput path individually.
 * Bash commands need individual processing to preserve per-command error
 * isolation, exit codes, and progress UI. Other non-slash commands are
 * batched: all items **with the same mode** as the highest-priority item
 * are drained at once and passed as a single array to executeInput — each
 * becomes its own user message with its own UUID. Different modes
 * (e.g. prompt vs task-notification) are never mixed because they are
 * treated differently downstream.
 *
 * The caller is responsible for ensuring no query is currently running
 * and for calling this function again after each command completes
 * until the queue is empty.
 *
 * @returns result with processed status
 */
export function processQueueIfReady({
  executeInput,
}: ProcessQueueParams): ProcessQueueResult {
  // This processor runs on the REPL main thread between turns. Skip anything
  // addressed to a subagent — an unfiltered peek() returning a subagent
  // notification would set targetMode, dequeueAllMatching would find nothing
  // matching that mode with agentId===undefined, and we'd return processed:
  // false with the queue unchanged → the React effect never re-fires and any
  // queued user prompt stalls permanently.
  // Poll events are not input: a turn's first request or a Poll call takes
  // them, and a waking one starts a turn below. A passive notice waits for
  // the next turn the same way.
  const isMainThread = (cmd: QueuedCommand) =>
    isDrainableMainThreadCommand(cmd) && cmd.mode !== 'poll-event'

  const next = peek(isMainThread)
  if (!next) {
    return dispatchForPollEvents(executeInput)
  }
  wokenFor = undefined

  // Slash commands and bash-mode commands are processed individually.
  // Bash commands need per-command error isolation, exit codes, and progress UI.
  if (isSlashCommand(next) || next.mode === 'bash' || next.runsAlone) {
    const cmd = dequeue(isMainThread)!
    void executeInput([cmd])
    return { processed: true }
  }

  // Drain all non-slash-command items with the same mode at once.
  const targetMode = next.mode
  const targetPriority = next.priority ?? 'next'
  const commands = dequeueAllMatching(
    cmd =>
      isMainThread(cmd) &&
      !isSlashCommand(cmd) &&
      !cmd.runsAlone &&
      cmd.mode === targetMode &&
      (cmd.priority ?? 'next') === targetPriority,
  )
  if (commands.length === 0) {
    return { processed: false }
  }

  void executeInput(commands)
  return { processed: true }
}

/** The waking event the last empty dispatch was for (official `pollEmptyDispatchStalled`). */
let wokenFor: QueuedCommand | undefined

/**
 * Official idle wake (2.1.325 chunk-rz2q8akm.js): with nothing else queued, a
 * main-thread poll event that wakes starts a turn as an empty prompt, and
 * that turn's first request folds the events in. When the same event is
 * still the head after its dispatch, the fold did not take it, and it waits
 * for the next turn instead of starting turns without end.
 */
function dispatchForPollEvents(
  executeInput: ProcessQueueParams['executeInput'],
): ProcessQueueResult {
  const head = peek(
    cmd =>
      cmd.agentId === undefined &&
      cmd.mode === 'poll-event' &&
      cmd.pollEvent !== undefined &&
      pollEventWakes(cmd.pollEvent),
  )
  if (!head) return { processed: false }
  if (wokenFor === head) {
    logForDebugging('poll empty dispatch stalled: the turn it started did not take the waking event', { level: 'error' })
    return { processed: false }
  }
  wokenFor = head
  void executeInput([
    {
      value: [],
      mode: 'prompt',
      isMeta: true,
      pollEmptyDispatch: true,
      skipSubmissionHooks: true,
    },
  ])
  return { processed: true }
}

/**
 * Checks if the queue has pending commands.
 * Use this to determine if queue processing should be triggered.
 */
export function hasQueuedCommands(): boolean {
  return hasCommandsInQueue()
}
