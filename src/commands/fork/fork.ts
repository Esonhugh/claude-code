import { randomUUID } from 'crypto'
import { getOriginalCwd, getSessionId, isSessionPersistenceDisabled } from '../../bootstrap/state.js'
import { spawnBackgroundSession } from '../../cli/bg.js'
import { FORK_GLYPH } from '../../constants/figures.js'
import { ENTER_WORKTREE_TOOL_NAME } from '../../tools/EnterWorktreeTool/constants.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { isBareMode, isSafeMode } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { findGitRoot } from '../../utils/git.js'
import { flushSessionStorage, getCurrentSessionTitle } from '../../utils/sessionStorage.js'
import { firstPrompt } from '../background/background.js'

// Official 2.1.329 status words for a background session.
const SESSION_RUNNING = 'session running'
const SESSION_WAITING = 'session waiting for a prompt'

/** Why this session cannot be forked, in official 2.1.329 wording; undefined when it can. */
export function forkRefusal(hasMessages: boolean): string | undefined {
  if (isSessionPersistenceDisabled()) {
    return "Can't fork: this session isn't being saved, so the new session would have nothing to start from. Run the task here, or fork from a session that saves its transcript."
  }
  if (isSafeMode() || isBareMode()) {
    return "Can't fork: this session was started with launch flags (safe or bare mode) that the copy wouldn't inherit, so it would run with fewer restrictions than this session. Run the task here, or start a session without those flags and fork from there."
  }
  if (!hasMessages) return 'Nothing to fork yet. Send a message first.'
  return undefined
}

/** Official 2.1.329 naming: `<parent> ⑂ <prompt>`, the prompt cut to 60 characters. */
export function forkName(parentName: string | undefined, prompt: string | undefined): string | undefined {
  const tail = prompt?.replace(/\s+/g, ' ').trim().slice(0, 60)
  if (parentName) return tail ? `${parentName} ${FORK_GLYPH} ${tail}` : `${parentName} ${FORK_GLYPH}`
  return tail ? `${FORK_GLYPH} ${tail}` : undefined
}

/** The fork shares this checkout with its parent, so it is told to make its own worktree first. */
export function checkoutNotice(cwd: string): string {
  return `This conversation was forked from a session that is still working in this checkout (${cwd}). Before making code changes, create a new worktree of your own with ${ENTER_WORKTREE_TOOL_NAME} so your edits don't land where the original session is editing.`
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const firstMessage = firstPrompt(context.messages)
  const refusal = forkRefusal(firstMessage !== undefined)
  if (refusal) {
    onDone(refusal, { display: 'system' })
    return null
  }
  const prompt = args.trim() || undefined
  const name = forkName(getCurrentSessionTitle(getSessionId()) ?? firstMessage, prompt)
  const cwd = getOriginalCwd()
  const appState = context.getAppState()
  const flags = ['--permission-mode', appState.toolPermissionContext.mode]
  if (appState.mainLoopModelForSession) flags.push('--model', appState.mainLoopModelForSession)
  if (findGitRoot(cwd)) flags.push('--append-system-prompt', checkoutNotice(cwd))
  try {
    await flushSessionStorage()
  } catch {
    onDone("Couldn't fork — this conversation is still being saved. Try again in a moment.", { display: 'system' })
    return null
  }
  try {
    const job = await spawnBackgroundSession({
      cwd,
      flags,
      prompt,
      sessionId: randomUUID(),
      forkFrom: getSessionId(),
      name,
      origin: `transient — started on-demand by /fork (pid ${process.pid}) in ${cwd}`,
    })
    const state = prompt ? SESSION_RUNNING : SESSION_WAITING
    onDone([state, job.name, job.id].filter(Boolean).join(' · '), { display: 'system' })
  } catch (error) {
    onDone(`Couldn't fork: ${errorMessage(error)}. This session is unaffected; try again.`, { display: 'system' })
  }
  return null
}
